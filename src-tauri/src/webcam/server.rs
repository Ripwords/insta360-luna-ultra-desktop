//! The webcam endpoint: the relay's pictures as MPEG-TS over plain HTTP on a
//! fixed localhost port, for OBS's Media Source.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinSet;

use super::nal::AccessUnit;
use super::relay::Relay;
use super::ts::TsMuxer;
use crate::liveview::write_within;
use crate::local_http::{
    read_request, status_response, Request, BAD_REQUEST, MISDIRECTED, REQUEST_TIMEOUT,
};

/// Fixed so the URL pasted into OBS keeps working between sessions.
pub const WEBCAM_PORT: u16 = 49283;
pub const WEBCAM_PATH: &str = "/webcam.ts";

/// A client that accepts no bytes for this long is closed.
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// Most clients streamed at once; more get 503. OBS needs one per source.
pub(crate) const MAX_CLIENTS: u32 = 8;
const UNAVAILABLE: &str = "503 Service Unavailable";

/// Serialises tests that bind the fixed port.
#[cfg(test)]
pub(crate) static FIXED_PORT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const OK_HEAD: &[u8] = concat!(
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: video/mp2t\r\n",
    "Cache-Control: no-store\r\n",
    "Connection: close\r\n\r\n"
)
.as_bytes();
const NOT_FOUND: &[u8] = concat!(
    "HTTP/1.1 404 Not Found\r\n",
    "Content-Type: text/plain\r\n",
    "Content-Length: 10\r\n",
    "Connection: close\r\n\r\n",
    "not found\n"
)
.as_bytes();

pub async fn bind_on(addr: SocketAddr) -> std::io::Result<TcpListener> {
    TcpListener::bind(addr).await
}

/// The fixed port, or any free one if something else holds it.
pub async fn bind_webcam() -> std::io::Result<TcpListener> {
    match bind_on(SocketAddr::from((Ipv4Addr::LOCALHOST, WEBCAM_PORT))).await {
        Ok(listener) => Ok(listener),
        Err(error) => {
            log::warn!("webcam port {WEBCAM_PORT} unavailable ({error}); using a free port");
            bind_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await
        }
    }
}

/// Serves `GET /webcam.ts` to every client that connects. `clients` counts
/// those currently streaming. Aborting this task closes every client socket.
pub async fn serve_ts(listener: TcpListener, relay: Arc<Relay>, clients: Arc<AtomicU32>) {
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    tasks.spawn(serve_client(
                        socket,
                        Arc::clone(&relay),
                        Arc::clone(&clients),
                        CLIENT_WRITE_TIMEOUT,
                    ));
                }
                Err(error) => {
                    log::warn!("webcam accept failed: {error}");
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                }
            },
            Some(_) = tasks.join_next() => {}
        }
    }
}

/// Counts a streaming client for as long as it lives, however its task ends.
struct Counted(Arc<AtomicU32>);

impl Counted {
    /// A slot, unless `MAX_CLIENTS` are already streaming.
    fn try_new(clients: Arc<AtomicU32>) -> Option<Self> {
        clients
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_CLIENTS).then_some(n + 1)
            })
            .ok()?;
        Some(Counted(clients))
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// One client: the head, then MPEG-TS from a clean start (the cached GOP, or
/// the next keyframe), then live pictures. A client that falls behind, or
/// accepts nothing for `write_timeout`, is closed rather than continued
/// mid-GOP; OBS reconnects and starts clean.
async fn serve_client(
    mut socket: TcpStream,
    relay: Arc<Relay>,
    clients: Arc<AtomicU32>,
    write_timeout: Duration,
) {
    let refusal = match read_request(&mut socket, REQUEST_TIMEOUT).await {
        Request::Get(path) if path == WEBCAM_PATH => None,
        Request::Get(_) => Some(NOT_FOUND.to_vec()),
        Request::WrongHost => Some(status_response(MISDIRECTED)),
        Request::Invalid => Some(status_response(BAD_REQUEST)),
    };
    if let Some(response) = refusal {
        let _ = write_within(&mut socket, &response, write_timeout).await;
        return;
    }
    let Some(_counted) = Counted::try_new(clients) else {
        let _ = write_within(&mut socket, &status_response(UNAVAILABLE), write_timeout).await;
        return;
    };
    let subscription = relay.subscribe();
    if !write_within(&mut socket, OK_HEAD, write_timeout).await {
        return;
    }
    let mut muxer = subscription
        .bootstrap
        .first()
        .and_then(|au| au.params.as_ref())
        .map(|params| TsMuxer::new(params.codec));
    if let Some(muxer) = muxer.as_mut() {
        for au in &subscription.bootstrap {
            if !write_within(&mut socket, &muxer.mux(au), write_timeout).await {
                return;
            }
        }
    }
    let mut live = subscription.live;
    loop {
        let au = match live.recv().await {
            Ok(au) => au,
            Err(RecvError::Lagged(_) | RecvError::Closed) => return,
        };
        if let (Some(current), Some(params)) = (&muxer, &au.params) {
            // A codec change needs a new PMT; the client reconnects for it.
            if current.codec() != params.codec {
                return;
            }
        }
        if muxer.is_none() {
            // Nothing cached at join time: start on a keyframe, led by the
            // params it was published with.
            let (true, Some(params)) = (au.keyframe, &au.params) else {
                continue;
            };
            let mut fresh = TsMuxer::new(params.codec);
            fresh.mux(&AccessUnit {
                data: params.annexb(),
                keyframe: false,
                params: Some(params.clone()),
                pts90k: au.pts90k,
            });
            muxer = Some(fresh);
        }
        let Some(current) = muxer.as_mut() else {
            continue;
        };
        if !write_within(&mut socket, &current.mux(&au), write_timeout).await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webcam::nal::{AccessUnit, AccessUnitAssembler, Codec, ParamSets};
    use std::process::Command;
    use std::sync::atomic::Ordering;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const HEVC_IDR: &[u8] = include_bytes!("../../tests/fixtures/hevc-idr.h265");
    const READ_LIMIT: Duration = Duration::from_secs(5);

    struct Server {
        port: u16,
        clients: Arc<AtomicU32>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn server(relay: &Arc<Relay>) -> Server {
        let listener = bind_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let clients = Arc::new(AtomicU32::new(0));
        let task = tokio::spawn(serve_ts(listener, Arc::clone(relay), Arc::clone(&clients)));
        Server {
            port,
            clients,
            task,
        }
    }

    async fn get(port: u16, path: &str) -> TcpStream {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: test\r\n\r\n");
        client.write_all(request.as_bytes()).await.unwrap();
        client
    }

    async fn read_head(client: &mut TcpStream) -> String {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            let n = tokio::time::timeout(READ_LIMIT, client.read(&mut byte))
                .await
                .expect("head timed out")
                .unwrap();
            assert_eq!(
                n,
                1,
                "closed inside the head: {:?}",
                String::from_utf8_lossy(&head)
            );
            head.push(byte[0]);
        }
        String::from_utf8(head).unwrap()
    }

    async fn read_at_least(client: &mut TcpStream, len: usize) -> Vec<u8> {
        let mut body = vec![0u8; len];
        tokio::time::timeout(READ_LIMIT, client.read_exact(&mut body))
            .await
            .expect("body timed out")
            .unwrap();
        body
    }

    async fn wait_for_clients(clients: &AtomicU32, count: u32) {
        for _ in 0..500 {
            if clients.load(Ordering::SeqCst) == count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "expected {count} clients, have {}",
            clients.load(Ordering::SeqCst)
        );
    }

    fn pid(packet: &[u8]) -> u16 {
        u16::from(packet[1] & 0x1f) << 8 | u16::from(packet[2])
    }

    fn pictures(bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut assembler = AccessUnitAssembler::new();
        let mut units = assembler.push(bytes, 0);
        units.extend(assembler.flush());
        units.into_iter().map(|unit| unit.data).collect()
    }

    fn feed(relay: &Relay, start: Instant, pics: &[Vec<u8>]) {
        for (i, pic) in pics.iter().enumerate() {
            relay.push_chunk(pic, start + Duration::from_millis(33 * i as u64 + 1));
        }
    }

    #[tokio::test]
    async fn serves_ts_with_mp2t_header() {
        let relay = Relay::new();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let server = server(&relay).await;
        let mut client = get(server.port, WEBCAM_PATH).await;
        let head = read_head(&mut client).await;
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
        assert!(head.contains("\r\nContent-Type: video/mp2t\r\n"), "{head}");
        assert!(head.contains("\r\nCache-Control: no-store\r\n"), "{head}");
        assert!(head.contains("\r\nConnection: close\r\n"), "{head}");
        let body = read_at_least(&mut client, 188 * 4).await;
        assert_eq!(body[0], 0x47);
        assert_eq!(pid(&body), 0x0000, "the stream opens with the PAT");
        assert!(body.chunks(188).all(|p| p[0] == 0x47));
        wait_for_clients(&server.clients, 1).await;
    }

    #[tokio::test]
    async fn a_client_before_any_video_starts_on_a_keyframe_with_params() {
        let relay = Relay::new();
        let server = server(&relay).await;
        let mut client = get(server.port, WEBCAM_PATH).await;
        read_head(&mut client).await;
        wait_for_clients(&server.clients, 1).await;
        let params = ParamSets {
            codec: Codec::H265,
            nals: vec![vec![0x40, 0x01, 0xaa]],
        };
        relay.push_au(
            AccessUnit {
                data: vec![0, 0, 0, 1, 0x02, 0x01, 0xbb],
                keyframe: false,
                params: Some(params.clone()),
                pts90k: 1,
            },
            Instant::now(),
        );
        relay.push_au(
            AccessUnit {
                data: vec![0, 0, 0, 1, 0x26, 0x01, 0xaf],
                keyframe: true,
                params: None,
                pts90k: 2,
            },
            Instant::now(),
        );
        // PAT, PMT, then one video packet: AUD, the keyframe's params, the slice.
        let body = read_at_least(&mut client, 188 * 3).await;
        assert_eq!(
            body.chunks(188).map(pid).collect::<Vec<_>>(),
            [0x0000, 0x1000, 0x0100]
        );
        let video = &body[376..];
        let es = [
            &[0, 0, 0, 1, 0x46, 0x01, 0x50][..],
            &params.annexb(),
            &[0, 0, 0, 1, 0x26, 0x01, 0xaf],
        ]
        .concat();
        assert!(
            video.ends_with(&es),
            "the P-frame before the keyframe is skipped"
        );
    }

    #[tokio::test]
    async fn other_paths_404() {
        let relay = Relay::new();
        let server = server(&relay).await;
        for path in ["/", "/stream", "/webcam.ts.bak", "/favicon.ico"] {
            let mut client = get(server.port, path).await;
            let mut response = String::new();
            tokio::time::timeout(READ_LIMIT, client.read_to_string(&mut response))
                .await
                .expect("a 404 must close the connection")
                .unwrap();
            assert!(
                response.starts_with("HTTP/1.1 404 Not Found\r\n"),
                "{path}: {response}"
            );
        }
        assert_eq!(server.clients.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn falls_back_when_port_taken() {
        let _fixed = FIXED_PORT.lock().await;
        let held = std::net::TcpListener::bind(("127.0.0.1", WEBCAM_PORT));
        let listener = bind_webcam().await.expect("must bind somewhere");
        let port = listener.local_addr().unwrap().port();
        if held.is_ok() {
            assert_ne!(port, WEBCAM_PORT);
            assert_ne!(port, 0);
        }
    }

    #[tokio::test]
    async fn lagging_client_is_closed() {
        let relay = Relay::new();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let server = server(&relay).await;
        let mut client = get(server.port, WEBCAM_PATH).await;
        read_head(&mut client).await;
        wait_for_clients(&server.clients, 1).await;
        for i in 0..2_000 {
            relay.push_au(
                AccessUnit {
                    data: [&[0, 0, 0, 1, 0x02, 0x01][..], &vec![0xaa; 64 * 1024]].concat(),
                    keyframe: false,
                    params: None,
                    pts90k: 10_000 + i,
                },
                Instant::now(),
            );
        }
        let drained = tokio::time::timeout(READ_LIMIT, async {
            let mut sink = Vec::new();
            client.read_to_end(&mut sink).await.map(|_| sink.len())
        })
        .await;
        assert!(drained
            .expect("a lagging client must be closed, not left hanging")
            .is_ok());
        wait_for_clients(&server.clients, 0).await;
    }

    #[tokio::test]
    async fn a_client_that_stops_reading_is_closed() {
        let relay = Relay::new();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let listener = bind_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = get(port, WEBCAM_PATH).await;
        let (socket, _) = listener.accept().await.unwrap();
        let clients = Arc::new(AtomicU32::new(0));
        let served = tokio::spawn(serve_client(
            socket,
            Arc::clone(&relay),
            Arc::clone(&clients),
            Duration::from_millis(200),
        ));
        wait_for_clients(&clients, 1).await;
        for i in 0..200 {
            relay.push_au(
                AccessUnit {
                    data: [&[0, 0, 0, 1, 0x02, 0x01][..], &vec![0xaa; 256 * 1024]].concat(),
                    keyframe: false,
                    params: None,
                    pts90k: 10_000 + i,
                },
                Instant::now(),
            );
        }
        tokio::time::timeout(Duration::from_secs(3), served)
            .await
            .expect("a client that stops reading must be closed")
            .unwrap();
        assert_eq!(clients.load(Ordering::SeqCst), 0);
        drop(client);
    }

    #[tokio::test]
    async fn a_departed_client_is_no_longer_counted() {
        let relay = Relay::new();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let server = server(&relay).await;
        let mut client = get(server.port, WEBCAM_PATH).await;
        read_head(&mut client).await;
        wait_for_clients(&server.clients, 1).await;
        drop(client);
        // The server notices on its next write.
        let start = Instant::now();
        for _ in 0..50 {
            feed(&relay, start, &pictures(HEVC_IDR)[..5]);
            if server.clients.load(Ordering::SeqCst) == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the departed client is still counted");
    }

    async fn response_to(port: u16, request: &str) -> String {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(READ_LIMIT, client.read_to_string(&mut response))
            .await
            .expect("a refused request must close the connection")
            .unwrap();
        response
    }

    #[tokio::test]
    async fn foreign_hosts_are_misdirected() {
        let relay = Relay::new();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let server = server(&relay).await;
        let port = server.port;
        for request in [
            format!("GET {WEBCAM_PATH} HTTP/1.1\r\nHost: evil.example\r\n\r\n"),
            format!("GET {WEBCAM_PATH} HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n"),
            format!("GET {WEBCAM_PATH} HTTP/1.1\r\n\r\n"),
        ] {
            let response = response_to(port, &request).await;
            assert!(
                response.starts_with("HTTP/1.1 421 Misdirected Request\r\n"),
                "{request:?}: {response}"
            );
        }
        // A refused request is never counted; localhost:{port} is served.
        assert_eq!(server.clients.load(Ordering::SeqCst), 0);
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(
                format!("GET {WEBCAM_PATH} HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        assert!(read_head(&mut client)
            .await
            .starts_with("HTTP/1.1 200 OK\r\n"));
        assert_eq!(server.clients.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn clients_beyond_the_cap_get_503() {
        let relay = Relay::new();
        relay.push_chunk(HEVC_IDR, Instant::now());
        let server = server(&relay).await;
        let mut streaming = Vec::new();
        for _ in 0..MAX_CLIENTS {
            let mut client = get(server.port, WEBCAM_PATH).await;
            assert!(read_head(&mut client)
                .await
                .starts_with("HTTP/1.1 200 OK\r\n"));
            streaming.push(client);
        }
        wait_for_clients(&server.clients, MAX_CLIENTS).await;
        let request = format!(
            "GET {WEBCAM_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            server.port
        );
        let response = response_to(server.port, &request).await;
        assert!(
            response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"),
            "{response}"
        );
        assert_eq!(server.clients.load(Ordering::SeqCst), MAX_CLIENTS);

        // A freed slot is usable again.
        drop(streaming.pop());
        let start = Instant::now();
        for _ in 0..50 {
            if server.clients.load(Ordering::SeqCst) < MAX_CLIENTS {
                break;
            }
            feed(&relay, start, &pictures(HEVC_IDR)[..5]);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let mut client = get(server.port, WEBCAM_PATH).await;
        assert!(read_head(&mut client)
            .await
            .starts_with("HTTP/1.1 200 OK\r\n"));
    }

    // ffprobe end to end -------------------------------------------------

    fn have_tools() -> bool {
        let found = ["ffprobe", "ffmpeg"]
            .iter()
            .all(|tool| Command::new(tool).arg("-version").output().is_ok());
        if !found {
            println!("skipping: ffprobe or ffmpeg not installed");
        }
        found
    }

    /// Runs a tool on a blocking thread, so the server keeps running on this
    /// one. A tool still running after `limit` is killed and the test fails.
    async fn run(program: &'static str, args: Vec<String>, limit: Duration) -> (String, String) {
        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            use std::process::Stdio;
            let mut child = Command::new(program)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect(program);
            let drain = |mut pipe: Box<dyn Read + Send>| {
                std::thread::spawn(move || {
                    let mut text = String::new();
                    let _ = pipe.read_to_string(&mut text);
                    text.trim().to_string()
                })
            };
            let out = drain(Box::new(child.stdout.take().unwrap()));
            let err = drain(Box::new(child.stderr.take().unwrap()));
            let deadline = Instant::now() + limit;
            while child.try_wait().unwrap().is_none() {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("{program} hung; killed after {limit:?}");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            (out.join().unwrap(), err.join().unwrap())
        })
        .await
        .unwrap()
    }

    /// Feeds the fixture once a client is streaming, then closes the server
    /// so the tool reads to the end instead of waiting on an endless stream.
    fn feed_then_close(relay: &Arc<Relay>, server: &Server) {
        let relay = Arc::clone(relay);
        let clients = Arc::clone(&server.clients);
        let task = server.task.abort_handle();
        tokio::spawn(async move {
            wait_for_clients(&clients, 1).await;
            feed(&relay, Instant::now(), &pictures(HEVC_IDR));
            // The fixture is ~72 KiB: the client has written it all by now.
            tokio::time::sleep(Duration::from_millis(300)).await;
            task.abort();
        });
    }

    #[tokio::test]
    async fn ffprobe_reads_the_url() {
        if !have_tools() {
            return;
        }
        let relay = Relay::new();
        let server = server(&relay).await;
        let url = format!("http://127.0.0.1:{}{WEBCAM_PATH}", server.port);
        feed_then_close(&relay, &server);
        let (out, err) = run(
            "ffprobe",
            [
                "-v",
                "error",
                "-rw_timeout",
                "5000000",
                "-analyzeduration",
                "1000000",
                "-show_entries",
                "stream=codec_name,width,height",
                "-of",
                "csv=p=0",
                &url,
            ]
            .map(String::from)
            .to_vec(),
            Duration::from_secs(20),
        )
        .await;
        assert_eq!(err, "");
        let mut lines: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
        lines.dedup();
        assert_eq!(lines, ["hevc,1280,720"]);
    }

    #[tokio::test]
    async fn ffmpeg_decodes_the_url_cleanly() {
        if !have_tools() {
            return;
        }
        let relay = Relay::new();
        let server = server(&relay).await;
        let url = format!("http://127.0.0.1:{}{WEBCAM_PATH}", server.port);
        feed_then_close(&relay, &server);
        let (out, err) = run(
            "ffmpeg",
            [
                "-v",
                "error",
                "-rw_timeout",
                "5000000",
                "-analyzeduration",
                "1000000",
                "-i",
                &url,
                "-frames:v",
                "45",
                "-progress",
                "pipe:1",
                "-f",
                "null",
                "-",
            ]
            .map(String::from)
            .to_vec(),
            Duration::from_secs(20),
        )
        .await;
        // The server closing the endless response is expected, not an error.
        let errors: Vec<&str> = err
            .lines()
            .filter(|line| {
                !(line.starts_with("[http @") && line.contains("Stream ends prematurely"))
            })
            .collect();
        assert!(errors.is_empty(), "decode errors over HTTP: {errors:?}");
        assert!(out.lines().any(|line| line == "frame=45"), "{out}");
    }
}
