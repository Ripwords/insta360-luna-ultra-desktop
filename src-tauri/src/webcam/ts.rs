//! MPEG-TS muxing of access units, so OBS's Media Source can play the
//! camera's preview from a plain HTTP URL.
//!
//! One program with one video stream. Each access unit becomes one PES
//! (PTS only, PTS = DTS), and the PES's first packet carries the PCR. PAT and
//! PMT go out before the first PES, before each keyframe, and at least every
//! [`PSI_INTERVAL`] ticks, so a player that joins mid-stream finds them fast.

use super::nal::{AccessUnit, Codec};

const PACKET_LEN: usize = 188;
const HEADER_LEN: usize = 4;
const SYNC: u8 = 0x47;

const PAT_PID: u16 = 0x0000;
const PMT_PID: u16 = 0x1000;
const VIDEO_PID: u16 = 0x0100;
const PROGRAM_NUMBER: u16 = 1;
const STREAM_ID: u8 = 0xe0;

/// Most 90 kHz ticks between PAT/PMT repeats (100 ms).
const PSI_INTERVAL: u64 = 9000;
/// PTS and the PCR base are 33-bit counters.
const PTS_MASK: u64 = (1 << 33) - 1;

const HEVC_AUD: [u8; 7] = [0, 0, 0, 1, 0x46, 0x01, 0x50];
const H264_AUD: [u8; 6] = [0, 0, 0, 1, 0x09, 0xf0];

pub fn stream_type(codec: Codec) -> u8 {
    match codec {
        Codec::H265 => 0x24,
        Codec::H264 => 0x1b,
    }
}

pub struct TsMuxer {
    codec: Codec,
    /// Continuity counters for PAT, PMT and video.
    cc_pat: u8,
    cc_pmt: u8,
    cc_video: u8,
    /// PTS of the last PAT/PMT pair, once one has been sent.
    last_psi: Option<u64>,
    /// The latest params-only AU's bytes, waiting for the next picture.
    held: Vec<u8>,
}

impl TsMuxer {
    pub fn new(codec: Codec) -> Self {
        Self {
            codec,
            cc_pat: 0,
            cc_pmt: 0,
            cc_video: 0,
            last_psi: None,
            held: Vec::new(),
        }
    }

    pub fn codec(&self) -> Codec {
        self.codec
    }

    /// Whole 188-byte packets for one access unit. A params-only AU (the
    /// relay's bootstrap entry) yields nothing: its bytes ride along with the
    /// next picture.
    pub fn mux(&mut self, au: &AccessUnit) -> Vec<u8> {
        if !has_vcl(self.codec, &au.data) {
            // Only the latest params apply; a params-only stream must not grow this.
            self.held.clear();
            self.held.extend_from_slice(&au.data);
            return Vec::new();
        }
        let pts = au.pts90k & PTS_MASK;
        let mut out = Vec::new();
        let psi_due = match self.last_psi {
            None => true,
            Some(last) => au.keyframe || pts.wrapping_sub(last) & PTS_MASK >= PSI_INTERVAL,
        };
        if psi_due {
            self.write_psi(&mut out);
            self.last_psi = Some(pts);
        }
        let pes = self.pes(au, pts);
        self.write_pes(&mut out, &pes, pts, au.keyframe);
        out
    }

    /// PES header, then AUD, held params, and the picture.
    fn pes(&mut self, au: &AccessUnit, pts: u64) -> Vec<u8> {
        let mut pes = Vec::with_capacity(14 + HEVC_AUD.len() + self.held.len() + au.data.len());
        pes.extend_from_slice(&[0, 0, 1, STREAM_ID, 0, 0, 0x84, 0x80, 5]);
        pes.extend_from_slice(&encode_pts(pts));

        let first = nals(&au.data).next();
        let rest = match first {
            Some((from, to)) if is_aud(self.codec, au.data[from]) => {
                pes.extend_from_slice(&au.data[..to]);
                &au.data[to..]
            }
            _ => {
                pes.extend_from_slice(match self.codec {
                    Codec::H265 => &HEVC_AUD,
                    Codec::H264 => &H264_AUD,
                });
                &au.data[..]
            }
        };
        pes.append(&mut self.held);
        pes.extend_from_slice(rest);
        pes
    }

    fn write_pes(&mut self, out: &mut Vec<u8>, pes: &[u8], pts: u64, keyframe: bool) {
        let mut af = vec![if keyframe { 0x50 } else { 0x10 }];
        af.extend_from_slice(&encode_pcr(pts));
        let mut rest = pes;
        let mut first = true;
        while !rest.is_empty() {
            let taken = write_packet(
                out,
                VIDEO_PID,
                first,
                &mut self.cc_video,
                first.then_some(&af[..]),
                rest,
            );
            rest = &rest[taken..];
            first = false;
        }
    }

    fn write_psi(&mut self, out: &mut Vec<u8>) {
        let [pn_hi, pn_lo] = PROGRAM_NUMBER.to_be_bytes();
        let [pmt_hi, pmt_lo] = PMT_PID.to_be_bytes();
        let pat = section(0x00, 0x0001, &[pn_hi, pn_lo, 0xe0 | pmt_hi, pmt_lo]);
        write_psi_packet(out, PAT_PID, &mut self.cc_pat, &pat);

        let [v_hi, v_lo] = VIDEO_PID.to_be_bytes();
        let pmt = section(
            0x02,
            PROGRAM_NUMBER,
            &[
                0xe0 | v_hi, // PCR PID
                v_lo,
                0xf0, // program_info_length 0
                0x00,
                stream_type(self.codec),
                0xe0 | v_hi,
                v_lo,
                0xf0, // ES_info_length 0
                0x00,
            ],
        );
        write_psi_packet(out, PMT_PID, &mut self.cc_pmt, &pmt);
    }
}

/// A long-form PSI section (version 0, current, single section) with CRC.
fn section(table_id: u8, id: u16, body: &[u8]) -> Vec<u8> {
    // id(2) + version(1) + section numbers(2) + body + CRC(4)
    let len = 5 + body.len() + 4;
    let mut s = vec![table_id, 0xb0 | (len >> 8) as u8, len as u8];
    s.extend_from_slice(&id.to_be_bytes());
    s.extend_from_slice(&[0xc1, 0x00, 0x00]);
    s.extend_from_slice(body);
    s.extend_from_slice(&crc32_mpeg2(&s).to_be_bytes());
    s
}

fn write_psi_packet(out: &mut Vec<u8>, pid: u16, cc: &mut u8, section: &[u8]) {
    let start = out.len();
    write_header(out, pid, true, cc, 0b01);
    out.push(0); // pointer_field
    out.extend_from_slice(section);
    out.resize(start + PACKET_LEN, 0xff);
}

/// Writes one packet from the front of `payload` and returns how many bytes
/// it took. A short payload is padded by stuffing the adaptation field.
fn write_packet(
    out: &mut Vec<u8>,
    pid: u16,
    pusi: bool,
    cc: &mut u8,
    af_fields: Option<&[u8]>,
    payload: &[u8],
) -> usize {
    // Adaptation field content after its length byte.
    let mut af: Option<Vec<u8>> = af_fields.map(<[u8]>::to_vec);
    let af_len = |af: &Option<Vec<u8>>| af.as_ref().map_or(0, |a| 1 + a.len());
    let room = PACKET_LEN - HEADER_LEN - af_len(&af);
    let taken = payload.len().min(room);
    let stuffing = room - taken;
    if stuffing > 0 {
        match &mut af {
            Some(fields) => fields.resize(fields.len() + stuffing, 0xff),
            // A one-byte field is just its zero length.
            None if stuffing == 1 => af = Some(Vec::new()),
            None => {
                let mut fields = vec![0x00];
                fields.resize(stuffing - 1, 0xff);
                af = Some(fields);
            }
        }
    }
    let control = if af.is_some() { 0b11 } else { 0b01 };
    write_header(out, pid, pusi, cc, control);
    if let Some(fields) = af {
        out.push(fields.len() as u8);
        out.extend_from_slice(&fields);
    }
    out.extend_from_slice(&payload[..taken]);
    taken
}

/// Every packet written here carries payload, so the counter always advances.
fn write_header(out: &mut Vec<u8>, pid: u16, pusi: bool, cc: &mut u8, control: u8) {
    let [hi, lo] = pid.to_be_bytes();
    out.extend_from_slice(&[
        SYNC,
        if pusi { 0x40 } else { 0 } | (hi & 0x1f),
        lo,
        control << 4 | *cc,
    ]);
    *cc = (*cc + 1) & 0x0f;
}

/// '0010' prefix, 33-bit PTS, marker bits.
fn encode_pts(pts: u64) -> [u8; 5] {
    [
        0x21 | ((pts >> 29) & 0x0e) as u8,
        (pts >> 22) as u8,
        0x01 | ((pts >> 14) & 0xfe) as u8,
        (pts >> 7) as u8,
        0x01 | ((pts << 1) & 0xfe) as u8,
    ]
}

/// PCR = pts × 300: base = pts, extension 0.
fn encode_pcr(pts: u64) -> [u8; 6] {
    [
        (pts >> 25) as u8,
        (pts >> 17) as u8,
        (pts >> 9) as u8,
        (pts >> 1) as u8,
        ((pts & 1) << 7) as u8 | 0x7e,
        0x00,
    ]
}

fn crc32_mpeg2(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= u32::from(byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04c1_1db7
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// `(payload start, end)` of each Annex-B NAL. `end` stops before the next
/// start code (3 or 4 bytes), so `data[..end]` ends with this NAL.
fn nals(data: &[u8]) -> impl Iterator<Item = (usize, usize)> + '_ {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let ends: Vec<usize> = starts
        .iter()
        .skip(1)
        .map(|&next| {
            // Back up over the next start code, 3 or 4 bytes.
            let mut end = next - 3;
            if end > 0 && data[end - 1] == 0 {
                end -= 1;
            }
            end
        })
        .chain(std::iter::once(data.len()))
        .collect();
    starts
        .into_iter()
        .zip(ends)
        .filter(move |&(from, to)| from < to && from < data.len())
}

fn is_aud(codec: Codec, header: u8) -> bool {
    match codec {
        Codec::H265 => (header >> 1) & 0x3f == 35,
        Codec::H264 => header & 0x1f == 9,
    }
}

fn has_vcl(codec: Codec, data: &[u8]) -> bool {
    nals(data).any(|(from, _)| match codec {
        Codec::H265 => (data[from] >> 1) & 0x3f <= 31,
        Codec::H264 => (1..=5).contains(&(data[from] & 0x1f)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webcam::nal::AccessUnitAssembler;
    use crate::webcam::relay::Relay;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant};

    const HEVC_IDR: &[u8] = include_bytes!("../../tests/fixtures/hevc-idr.h265");
    const HEVC_SWITCH: &[u8] = include_bytes!("../../tests/fixtures/hevc-switch.h265");
    const H264_IDR: &[u8] = include_bytes!("../../tests/fixtures/h264-idr.h264");

    const PAT_PID: u16 = 0x0000;
    const PMT_PID: u16 = 0x1000;
    const VIDEO_PID: u16 = 0x0100;
    const FRAME_TICKS: u64 = 3000;

    /// The fixture's pictures, re-fed one per chunk at 30 fps.
    fn units_at_30fps(bytes: &[u8]) -> Vec<AccessUnit> {
        let mut splitter = AccessUnitAssembler::new();
        let mut pictures = splitter.push(bytes, 0);
        pictures.extend(splitter.flush());

        let mut assembler = AccessUnitAssembler::new();
        let mut units = Vec::new();
        for (i, picture) in pictures.iter().enumerate() {
            units.extend(assembler.push(&picture.data, i as u64 * FRAME_TICKS));
        }
        units.extend(assembler.flush());
        units
    }

    fn mux_all(codec: Codec, units: &[AccessUnit]) -> Vec<u8> {
        let mut muxer = TsMuxer::new(codec);
        units.iter().flat_map(|au| muxer.mux(au)).collect()
    }

    struct Packet<'a> {
        pid: u16,
        pusi: bool,
        cc: u8,
        has_payload: bool,
        /// Adaptation field after its length byte.
        adaptation: Option<&'a [u8]>,
        payload: &'a [u8],
    }

    fn parse(ts: &[u8]) -> Vec<Packet<'_>> {
        assert_eq!(ts.len() % 188, 0, "not whole packets");
        ts.chunks(188)
            .map(|p| {
                assert_eq!(p[0], 0x47);
                let afc = (p[3] >> 4) & 0b11;
                let (adaptation, payload_at) = if afc & 0b10 != 0 {
                    let len = p[4] as usize;
                    (Some(&p[5..5 + len]), 5 + len)
                } else {
                    (None, 4)
                };
                Packet {
                    pid: u16::from(p[1] & 0x1f) << 8 | u16::from(p[2]),
                    pusi: p[1] & 0x40 != 0,
                    cc: p[3] & 0x0f,
                    has_payload: afc & 0b01 != 0,
                    adaptation,
                    payload: if afc & 0b01 != 0 {
                        &p[payload_at..]
                    } else {
                        &[]
                    },
                }
            })
            .collect()
    }

    /// One reassembled PES, with the PSI tables sent since the previous one.
    struct Pes {
        psi_before: Vec<u16>,
        random_access: bool,
        pcr: Option<u64>,
        bytes: Vec<u8>,
    }

    fn decode_pcr(af: &[u8]) -> Option<u64> {
        if af.is_empty() || af[0] & 0x10 == 0 {
            return None;
        }
        let b = &af[1..7];
        let base = u64::from(b[0]) << 25
            | u64::from(b[1]) << 17
            | u64::from(b[2]) << 9
            | u64::from(b[3]) << 1
            | u64::from(b[4]) >> 7;
        let ext = u64::from(b[4] & 1) << 8 | u64::from(b[5]);
        Some(base * 300 + ext)
    }

    fn pes_list(ts: &[u8]) -> Vec<Pes> {
        let mut out: Vec<Pes> = Vec::new();
        let mut psi = Vec::new();
        for p in parse(ts) {
            match p.pid {
                PAT_PID | PMT_PID => psi.push(p.pid),
                VIDEO_PID if p.pusi => {
                    let af = p.adaptation.unwrap_or(&[]);
                    out.push(Pes {
                        psi_before: std::mem::take(&mut psi),
                        random_access: af.first().is_some_and(|f| f & 0x40 != 0),
                        pcr: decode_pcr(af),
                        bytes: p.payload.to_vec(),
                    });
                }
                VIDEO_PID => out
                    .last_mut()
                    .expect("continuation before PES start")
                    .bytes
                    .extend_from_slice(p.payload),
                other => panic!("unexpected PID {other:#x}"),
            }
        }
        out
    }

    fn pes_pts(pes: &[u8]) -> u64 {
        assert_eq!(&pes[..4], &[0, 0, 1, 0xe0]);
        assert_eq!(&pes[4..6], &[0, 0], "PES_packet_length");
        assert_eq!(pes[6], 0x84, "marker bits + data_alignment_indicator");
        assert_eq!(pes[7], 0x80, "PTS only");
        assert_eq!(pes[8], 5);
        let b = &pes[9..14];
        assert_eq!(b[0] & 0xf1, 0x21);
        u64::from(b[0] >> 1 & 0x07) << 30
            | u64::from(b[1]) << 22
            | u64::from(b[2] >> 1) << 15
            | u64::from(b[3]) << 7
            | u64::from(b[4] >> 1)
    }

    fn pes_es(pes: &[u8]) -> &[u8] {
        &pes[9 + pes[8] as usize..]
    }

    /// The PSI section of a PAT/PMT packet, without its CRC.
    fn psi_section(ts: &[u8], pid: u16) -> &[u8] {
        let p = parse(ts).into_iter().find(|p| p.pid == pid).expect("table");
        let s = &p.payload[1 + p.payload[0] as usize..];
        let len = (usize::from(s[1] & 0x0f) << 8 | usize::from(s[2])) + 3;
        assert_eq!(crc32_mpeg2(&s[..len]), 0, "CRC");
        &s[..len - 4]
    }

    #[test]
    fn packets_are_188_with_sync_bytes() {
        let ts = mux_all(Codec::H265, &units_at_30fps(HEVC_IDR));
        assert!(!ts.is_empty());
        assert_eq!(ts.len() % 188, 0);
        assert!(ts.chunks(188).all(|p| p[0] == 0x47));
    }

    #[test]
    fn continuity_counters_increment_per_pid() {
        let ts = mux_all(Codec::H265, &units_at_30fps(HEVC_IDR));
        let mut last: HashMap<u16, u8> = HashMap::new();
        for p in parse(&ts) {
            assert!(p.has_payload);
            if let Some(prev) = last.insert(p.pid, p.cc) {
                assert_eq!(p.cc, (prev + 1) % 16, "PID {:#x}", p.pid);
            } else {
                assert_eq!(p.cc, 0, "PID {:#x} first CC", p.pid);
            }
        }
        assert_eq!(last.len(), 3);
    }

    #[test]
    fn pat_pmt_before_every_keyframe_and_every_100ms() {
        let units = units_at_30fps(HEVC_IDR);
        let ts = mux_all(Codec::H265, &units);
        let pes = pes_list(&ts);
        assert_eq!(pes.len(), units.len());
        let mut last_psi = None;
        for (au, pes) in units.iter().zip(&pes) {
            let pts = pes_pts(&pes.bytes);
            if !pes.psi_before.is_empty() {
                assert_eq!(pes.psi_before, [PAT_PID, PMT_PID]);
                last_psi = Some(pts);
            }
            if au.keyframe {
                assert_eq!(pes.psi_before, [PAT_PID, PMT_PID], "keyframe at {pts}");
            }
            let since = pts - last_psi.expect("PSI before first PES");
            assert!(since < 9000, "{since} ticks without PSI at {pts}");
        }
        assert!(units.iter().filter(|au| au.keyframe).count() >= 2);
    }

    #[test]
    fn pat_and_pmt_have_fixed_ids_and_valid_crc() {
        let ts = mux_all(Codec::H265, &units_at_30fps(HEVC_IDR));
        let pat = psi_section(&ts, PAT_PID);
        assert_eq!(pat[0], 0x00);
        assert_eq!(
            &pat[8..12],
            &[0x00, 0x01, 0xf0, 0x00],
            "program 1 -> 0x1000"
        );
        let pmt = psi_section(&ts, PMT_PID);
        assert_eq!(pmt[0], 0x02);
        assert_eq!(&pmt[8..10], &[0xe1, 0x00], "PCR PID 0x0100");
        assert_eq!(&pmt[13..15], &[0xe1, 0x00], "video PID 0x0100");
    }

    #[test]
    fn pmt_declares_stream_type() {
        assert_eq!(stream_type(Codec::H265), 0x24);
        assert_eq!(stream_type(Codec::H264), 0x1b);
        for (codec, bytes, expected) in
            [(Codec::H265, HEVC_IDR, 0x24), (Codec::H264, H264_IDR, 0x1b)]
        {
            let ts = mux_all(codec, &units_at_30fps(bytes));
            let pmt = psi_section(&ts, PMT_PID);
            assert_eq!(pmt[12], expected, "{codec:?}");
        }
    }

    #[test]
    fn pes_carries_pts_and_pcr() {
        let units = units_at_30fps(HEVC_IDR);
        let pes = pes_list(&mux_all(Codec::H265, &units));
        assert_eq!(pes.len(), units.len());
        for (au, pes) in units.iter().zip(&pes) {
            assert_eq!(pes_pts(&pes.bytes), au.pts90k);
            assert_eq!(pes.pcr, Some(au.pts90k * 300));
            assert_eq!(pes.random_access, au.keyframe);
        }
    }

    #[test]
    fn each_pes_is_aud_led_and_carries_the_whole_picture() {
        for (codec, bytes, aud) in [
            (Codec::H265, HEVC_IDR, &[0, 0, 0, 1, 0x46, 0x01, 0x50][..]),
            (Codec::H264, H264_IDR, &[0, 0, 0, 1, 0x09, 0xf0][..]),
        ] {
            let units = units_at_30fps(bytes);
            let pes = pes_list(&mux_all(codec, &units));
            assert_eq!(pes.len(), units.len(), "{codec:?}");
            for (au, pes) in units.iter().zip(&pes) {
                assert_eq!(pes_es(&pes.bytes), [aud, &au.data[..]].concat());
            }
        }
    }

    #[test]
    fn an_existing_aud_is_not_doubled() {
        let aud = [0, 0, 0, 1, 0x46, 0x01, 0x10];
        let slice = [0, 0, 0, 1, 0x26, 0x01, 0x80, 0xaa];
        let au = AccessUnit {
            data: [&aud[..], &slice[..]].concat(),
            keyframe: true,
            params: None,
            pts90k: 10,
        };
        let pes = pes_list(&TsMuxer::new(Codec::H265).mux(&au));
        assert_eq!(pes_es(&pes[0].bytes), au.data);
    }

    #[test]
    fn a_params_only_au_is_prepended_to_the_next() {
        let params = [0, 0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 0, 1, 0x42, 0x01, 0x01];
        let aud = [0, 0, 0, 1, 0x46, 0x01, 0x10];
        let slice = [0, 0, 0, 1, 0x26, 0x01, 0x80, 0xaa];
        let mut muxer = TsMuxer::new(Codec::H265);
        let bootstrap = AccessUnit {
            data: params.to_vec(),
            keyframe: false,
            params: None,
            pts90k: 10,
        };
        assert!(muxer.mux(&bootstrap).is_empty());
        let keyframe = AccessUnit {
            data: [&aud[..], &slice[..]].concat(),
            keyframe: true,
            params: None,
            pts90k: 10,
        };
        let pes = pes_list(&muxer.mux(&keyframe));
        assert_eq!(pes.len(), 1);
        assert_eq!(pes[0].psi_before, [PAT_PID, PMT_PID]);
        assert_eq!(pes_es(&pes[0].bytes), [&aud[..], &params, &slice].concat());

        // Held params go out once.
        let next = AccessUnit {
            data: slice.to_vec(),
            keyframe: false,
            params: None,
            pts90k: 3010,
        };
        let pes = pes_list(&muxer.mux(&next));
        assert_eq!(
            pes_es(&pes[0].bytes),
            [&[0, 0, 0, 1, 0x46, 0x01, 0x50][..], &slice].concat()
        );
    }

    #[test]
    fn held_params_are_replaced_not_appended() {
        let vps = [0, 0, 0, 1, 0x40, 0x01, 0x0c];
        let newer = [0, 0, 0, 1, 0x40, 0x01, 0x0d];
        let slice = [0, 0, 0, 1, 0x26, 0x01, 0x80, 0xaa];
        let mut muxer = TsMuxer::new(Codec::H265);
        for data in [&vps[..], &vps, &newer] {
            let params_only = AccessUnit {
                data: data.to_vec(),
                keyframe: false,
                params: None,
                pts90k: 10,
            };
            assert!(muxer.mux(&params_only).is_empty());
        }
        let keyframe = AccessUnit {
            data: slice.to_vec(),
            keyframe: true,
            params: None,
            pts90k: 10,
        };
        let pes = pes_list(&muxer.mux(&keyframe));
        assert_eq!(
            pes_es(&pes[0].bytes),
            [&[0, 0, 0, 1, 0x46, 0x01, 0x50][..], &newer, &slice].concat(),
            "only the latest params-only AU rides along"
        );
    }

    /// Payload sizes around the first packet's 176-byte room and the
    /// following packets' 184, so the last packet needs 0, 1, 2 and more
    /// bytes of stuffing.
    #[test]
    fn pes_survives_every_size_across_packet_boundaries() {
        let aud = [0, 0, 0, 1, 0x46, 0x01, 0x50];
        let mut stuffing_seen = [false; 3];
        // ES = AUD (7) + slice header (6) + filler; PES header is 14 bytes.
        for filler in 120..=600 {
            let mut data = vec![0, 0, 0, 1, 0x26, 0x01];
            data.resize(6 + filler, 0xaa);
            let au = AccessUnit {
                data: data.clone(),
                keyframe: false,
                params: None,
                pts90k: 10,
            };
            let ts = TsMuxer::new(Codec::H265).mux(&au);
            let packets = parse(&ts);
            for p in packets.iter().filter(|p| p.pid == VIDEO_PID) {
                let af = p.adaptation.map_or(0, |a| a.len());
                assert!(af <= 183, "adaptation field of {af} bytes");
                if !p.pusi {
                    // A trailing packet's adaptation field is pure stuffing.
                    match p.adaptation.map(<[u8]>::len) {
                        None => stuffing_seen[0] = true,
                        Some(0) => stuffing_seen[1] = true,
                        Some(1) => stuffing_seen[2] = true,
                        Some(_) => {}
                    }
                }
            }
            let pes = pes_list(&ts);
            assert_eq!(pes.len(), 1, "filler {filler}");
            assert_eq!(
                pes_es(&pes[0].bytes),
                [&aud[..], &data].concat(),
                "filler {filler}"
            );
        }
        assert_eq!(
            stuffing_seen, [true; 3],
            "no-stuffing, 1-byte and 2-byte stuffing must all occur"
        );
    }

    #[test]
    fn pts_wraps_at_33_bits() {
        let au = AccessUnit {
            data: vec![0, 0, 0, 1, 0x26, 0x01, 0x80, 0xaa],
            keyframe: true,
            params: None,
            pts90k: (1 << 33) + 7,
        };
        let pes = pes_list(&TsMuxer::new(Codec::H265).mux(&au));
        assert_eq!(pes_pts(&pes[0].bytes), 7);
        assert_eq!(pes[0].pcr, Some(7 * 300));
    }

    // ffmpeg conformance --------------------------------------------------

    struct TempTs(PathBuf);

    impl TempTs {
        fn write(test: &str, ts: &[u8]) -> Self {
            let path =
                std::env::temp_dir().join(format!("luna-webcam-{}-{test}.ts", std::process::id()));
            std::fs::write(&path, ts).expect("write temp TS");
            Self(path)
        }
    }

    impl Drop for TempTs {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// The conformance tests run both ffprobe and ffmpeg.
    fn have_ffprobe() -> bool {
        let found = ["ffprobe", "ffmpeg"]
            .iter()
            .all(|tool| Command::new(tool).arg("-version").output().is_ok());
        if !found {
            println!("skipping: ffprobe or ffmpeg not installed");
        }
        found
    }

    fn run(program: &str, args: &[&str]) -> (String, String) {
        let out = Command::new(program).args(args).output().expect(program);
        (
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        )
    }

    fn probe_stream(file: &TempTs) -> String {
        let path = file.0.to_str().expect("utf-8 temp path");
        let (out, err) = run(
            "ffprobe",
            &[
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name,width,height",
                "-of",
                "csv=p=0",
                path,
            ],
        );
        assert_eq!(err, "");
        // ffprobe lists a TS stream twice, under its program and on its own.
        let mut lines: Vec<&str> = out.lines().filter(|l| !l.is_empty()).collect();
        lines.dedup();
        lines.join("\n")
    }

    fn decode_errors(file: &TempTs) -> String {
        let path = file.0.to_str().expect("utf-8 temp path");
        run("ffmpeg", &["-v", "error", "-i", path, "-f", "null", "-"]).1
    }

    /// Decoded frame sizes, in output order.
    fn frame_sizes(file: &TempTs) -> Vec<String> {
        let path = file.0.to_str().expect("utf-8 temp path");
        let (out, err) = run(
            "ffprobe",
            &[
                "-v",
                "error",
                "-show_entries",
                "frame=width,height",
                "-of",
                "csv=p=0",
                path,
            ],
        );
        assert_eq!(err, "");
        // Frames with side data (the encoder's SEI) add an empty field, or on
        // older ffprobe an empty line.
        out.lines()
            .map(|l| l.trim_end_matches(','))
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn ffmpeg_decodes_fixture() {
        if !have_ffprobe() {
            return;
        }
        let file = TempTs::write(
            "ffmpeg_decodes_fixture",
            &mux_all(Codec::H265, &units_at_30fps(HEVC_IDR)),
        );
        assert_eq!(probe_stream(&file), "hevc,1280,720");
        assert_eq!(decode_errors(&file), "");
        assert_eq!(frame_sizes(&file).len(), 60);

        let file = TempTs::write(
            "ffmpeg_decodes_fixture_h264",
            &mux_all(Codec::H264, &units_at_30fps(H264_IDR)),
        );
        assert_eq!(probe_stream(&file), "h264,1280,720");
        assert_eq!(decode_errors(&file), "");
        assert_eq!(frame_sizes(&file).len(), 60);
    }

    #[test]
    fn ffmpeg_decodes_mode_switch_without_errors() {
        if !have_ffprobe() {
            return;
        }
        let file = TempTs::write(
            "ffmpeg_decodes_mode_switch_without_errors",
            &mux_all(Codec::H265, &units_at_30fps(HEVC_SWITCH)),
        );
        assert_eq!(probe_stream(&file), "hevc,1280,720");
        assert_eq!(decode_errors(&file), "");
        let sizes = frame_sizes(&file);
        assert_eq!(sizes.len(), 120);
        assert!(sizes[..60].iter().all(|s| s == "1280,720"), "{sizes:?}");
        assert!(sizes[60..].iter().all(|s| s == "720,1280"), "{sizes:?}");
    }

    #[test]
    fn ffmpeg_decodes_a_late_joiner_from_the_relay_bootstrap() {
        if !have_ffprobe() {
            return;
        }
        let mut splitter = AccessUnitAssembler::new();
        let mut pictures = splitter.push(HEVC_IDR, 0);
        pictures.extend(splitter.flush());

        let relay = Relay::new();
        let start = Instant::now();
        let feed = |from: usize, to: usize| {
            for (i, pic) in pictures.iter().enumerate().take(to).skip(from) {
                relay.push_chunk(&pic.data, start + Duration::from_millis(33 * i as u64 + 1));
            }
        };
        // Join mid-GOP, a few pictures after the keyframe at AU 30.
        feed(0, 36);
        let mut sub = relay.subscribe();
        feed(36, pictures.len());

        let mut muxer = TsMuxer::new(Codec::H265);
        let mut ts = Vec::new();
        for au in &sub.bootstrap {
            ts.extend(muxer.mux(au));
        }
        let mut live = 0;
        while let Ok(au) = sub.live.try_recv() {
            ts.extend(muxer.mux(&au));
            live += 1;
        }
        let file = TempTs::write("ffmpeg_decodes_a_late_joiner_from_the_relay_bootstrap", &ts);
        assert_eq!(probe_stream(&file), "hevc,1280,720");
        assert_eq!(decode_errors(&file), "");
        // Everything from the keyframe except the picture still held back.
        assert_eq!(sub.bootstrap.len() - 1 + live, 60 - 30 - 1);
        assert_eq!(frame_sizes(&file).len(), 29);
    }
}
