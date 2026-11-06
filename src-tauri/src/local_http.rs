//! The request side of the localhost stream servers (viewfinder and webcam).
//!
//! Both bind 127.0.0.1 only, but a web page could still reach them through
//! DNS rebinding: its own hostname re-pointed at 127.0.0.1. Such a request
//! carries the page's hostname in `Host`, so only requests naming the
//! loopback address or `localhost`, with the server's own port, are served.

use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

/// A client must send its whole request head within this long.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Longest request head read; anything longer is not a request we serve.
const MAX_REQUEST: usize = 8 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Request {
    /// A GET for this path (query and fragment stripped), with a valid Host.
    Get(String),
    /// A well-formed request whose `Host` is missing or not ours.
    WrongHost,
    /// Not a GET, malformed, too long, or never completed.
    Invalid,
}

/// Reads and checks one request head, giving up after `limit`.
pub(crate) async fn read_request(socket: &mut TcpStream, limit: Duration) -> Request {
    let Ok(port) = socket.local_addr().map(|addr| addr.port()) else {
        return Request::Invalid;
    };
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    let read = async {
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = socket.read(&mut chunk).await.ok()?;
            if n == 0 || head.len() + n > MAX_REQUEST {
                return None;
            }
            head.extend_from_slice(&chunk[..n]);
        }
        Some(())
    };
    match tokio::time::timeout(limit, read).await {
        Ok(Some(())) => parse(&head, port),
        _ => Request::Invalid,
    }
}

fn parse(head: &[u8], port: u16) -> Request {
    let Ok(head) = std::str::from_utf8(head) else {
        return Request::Invalid;
    };
    let head = head.split("\r\n\r\n").next().unwrap_or_default();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let (Some("GET"), Some(target), Some(_version)) = (
        request_line.next(),
        request_line.next(),
        request_line.next(),
    ) else {
        return Request::Invalid;
    };
    let mut hosts = lines.filter_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("host")
            .then(|| value.trim())
    });
    let ours = |host: &str| {
        let Some((name, host_port)) = host.rsplit_once(':') else {
            return false;
        };
        (name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost"))
            && host_port == port.to_string()
    };
    match (hosts.next(), hosts.next()) {
        (Some(host), None) if ours(host) => {
            let path = target.split(['?', '#']).next().unwrap_or_default();
            Request::Get(path.to_string())
        }
        _ => Request::WrongHost,
    }
}

/// A complete, body-less response that closes the connection.
pub(crate) fn status_response(status: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
}

pub(crate) const MISDIRECTED: &str = "421 Misdirected Request";
pub(crate) const BAD_REQUEST: &str = "400 Bad Request";

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    fn get(host: Option<&str>) -> Vec<u8> {
        let host = host.map(|h| format!("Host: {h}\r\n")).unwrap_or_default();
        format!("GET /webcam.ts?x=1 HTTP/1.1\r\n{host}User-Agent: Lavf/61.7.100\r\n\r\n")
            .into_bytes()
    }

    #[test]
    fn loopback_and_localhost_with_our_port_are_served() {
        for host in [
            "127.0.0.1:49283",
            "localhost:49283",
            "LocalHost:49283",
            " 127.0.0.1:49283 ",
        ] {
            assert_eq!(
                parse(&get(Some(host)), 49283),
                Request::Get("/webcam.ts".into()),
                "{host}"
            );
        }
        let lower = b"GET / HTTP/1.1\r\nhost: 127.0.0.1:7\r\n\r\n";
        assert_eq!(parse(lower, 7), Request::Get("/".into()));
    }

    #[test]
    fn any_other_host_is_misdirected() {
        for host in [
            Some("evil.example"),
            Some("evil.example:49283"),
            Some("127.0.0.1"),
            Some("127.0.0.1:1234"),
            Some("localhost"),
            Some("127.0.0.1:49283.evil.example"),
            Some("[::1]:49283"),
            Some(""),
            None,
        ] {
            assert_eq!(parse(&get(host), 49283), Request::WrongHost, "{host:?}");
        }
        let twice = b"GET / HTTP/1.1\r\nHost: 127.0.0.1:7\r\nHost: evil.example\r\n\r\n";
        assert_eq!(parse(twice, 7), Request::WrongHost);
    }

    #[test]
    fn non_get_and_garbage_are_invalid() {
        assert_eq!(
            parse(b"POST / HTTP/1.1\r\nHost: 127.0.0.1:7\r\n\r\n", 7),
            Request::Invalid
        );
        assert_eq!(parse(b"\xff\xfe\r\n\r\n", 7), Request::Invalid);
        assert_eq!(parse(b"GET\r\n\r\n", 7), Request::Invalid);
    }

    #[tokio::test]
    async fn a_silent_client_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = tokio::time::timeout(
            Duration::from_secs(2),
            read_request(&mut socket, Duration::from_millis(100)),
        )
        .await
        .expect("the read must give up on its own");
        assert_eq!(request, Request::Invalid);
    }

    #[tokio::test]
    async fn reads_a_request_split_across_writes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = format!("GET /a HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n");
        let (first, second) = request.as_bytes().split_at(10);
        client.write_all(first).await.unwrap();
        let writer = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            client.write_all(second).await.unwrap();
        };
        let (request, ()) = tokio::join!(read_request(&mut socket, REQUEST_TIMEOUT), writer);
        assert_eq!(request, Request::Get("/a".into()));
    }
}
