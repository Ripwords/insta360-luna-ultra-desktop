//! Annex-B access-unit assembly for the camera's preview stream.
//!
//! The camera sends a raw H.265 (or H.264) elementary stream, and the network
//! chunks it arbitrarily. [`AccessUnitAssembler`] reassembles those chunks into
//! whole pictures, flags keyframes, and collects the parameter sets each
//! picture carried in-band, which is what a muxer needs to place one picture
//! per packet and to start a new viewer on a keyframe.

const START_CODE: [u8; 4] = [0, 0, 0, 1];

const H265_IRAP: std::ops::RangeInclusive<u8> = 16..=21;
const H265_VCL_MAX: u8 = 31;
const H265_VPS: u8 = 32;
const H265_SPS: u8 = 33;
const H265_PPS: u8 = 34;
const H265_AUD: u8 = 35;
const H265_PREFIX_SEI: u8 = 39;

const H264_VCL: std::ops::RangeInclusive<u8> = 1..=5;
const H264_IDR: u8 = 5;
const H264_SEI: u8 = 6;
const H264_SPS: u8 = 7;
const H264_PPS: u8 = 8;
const H264_AUD: u8 = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    H265,
}

/// One picture: every NAL from its first (AUD, parameter set or first slice)
/// up to the start of the next picture.
#[derive(Debug, Clone, PartialEq)]
pub struct AccessUnit {
    /// Annex-B, each NAL behind a 4-byte start code.
    pub data: Vec<u8>,
    pub keyframe: bool,
    pub params: Option<ParamSets>,
    pub pts90k: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParamSets {
    pub codec: Codec,
    /// VPS, SPS, PPS for H.265; SPS, PPS for H.264. No start codes.
    pub nals: Vec<Vec<u8>>,
}

/// What a NAL means for access-unit boundaries.
struct NalInfo {
    vcl: bool,
    /// A VCL NAL that opens a new picture.
    first_slice: bool,
    /// A non-VCL NAL that may only precede a picture's slices.
    starts_au: bool,
    irap: bool,
    /// Slot in [`ParamSets::nals`] if this is a parameter set.
    param_slot: Option<usize>,
}

impl NalInfo {
    fn of(codec: Codec, nal: &[u8]) -> Self {
        match codec {
            Codec::H265 => {
                let kind = (nal[0] >> 1) & 0x3f;
                let vcl = kind <= H265_VCL_MAX;
                Self {
                    vcl,
                    first_slice: vcl && nal.get(2).is_some_and(|b| b & 0x80 != 0),
                    starts_au: matches!(
                        kind,
                        H265_VPS | H265_SPS | H265_PPS | H265_AUD | H265_PREFIX_SEI
                    ),
                    irap: H265_IRAP.contains(&kind),
                    param_slot: match kind {
                        H265_VPS => Some(0),
                        H265_SPS => Some(1),
                        H265_PPS => Some(2),
                        _ => None,
                    },
                }
            }
            Codec::H264 => {
                let kind = nal[0] & 0x1f;
                let vcl = H264_VCL.contains(&kind);
                Self {
                    vcl,
                    // first_mb_in_slice is ue(v); a value of 0 codes as the single bit '1'.
                    first_slice: vcl && nal.get(1).is_some_and(|b| b & 0x80 != 0),
                    starts_au: matches!(kind, H264_SEI | H264_SPS | H264_PPS | H264_AUD),
                    irap: kind == H264_IDR,
                    param_slot: match kind {
                        H264_SPS => Some(0),
                        H264_PPS => Some(1),
                        _ => None,
                    },
                }
            }
        }
    }
}

/// Mirrors `app/utils/annexB.ts::detectCodec` for a single NAL.
fn detect_codec(nal: &[u8]) -> Option<Codec> {
    let b0 = *nal.first()?;
    if b0 & 0x80 != 0 {
        return None;
    }
    if matches!((b0 >> 1) & 0x3f, H265_VPS | H265_SPS | H265_PPS) {
        return Some(Codec::H265);
    }
    if matches!(b0 & 0x1f, H264_SPS | H264_PPS) {
        return Some(Codec::H264);
    }
    None
}

/// The picture being collected.
struct OpenAu {
    data: Vec<u8>,
    keyframe: bool,
    has_vcl: bool,
    params: Vec<Option<Vec<u8>>>,
    pts90k: u64,
}

impl OpenAu {
    fn close(self, codec: Codec) -> AccessUnit {
        let params = self
            .params
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .map(|nals| ParamSets { codec, nals });
        AccessUnit {
            data: self.data,
            keyframe: self.keyframe,
            params,
            pts90k: self.pts90k,
        }
    }
}

/// Incremental Annex-B to access-unit splitter. Feed it chunks in stream
/// order; it carries partial NALs and the open picture between calls.
#[derive(Default)]
pub struct AccessUnitAssembler {
    /// Unconsumed bytes. Once a start code has been seen, this begins at the
    /// payload of the NAL currently being read.
    buf: Vec<u8>,
    /// Whether `buf` starts at a NAL payload (false before the first start code).
    in_nal: bool,
    /// pts of the chunk holding the current NAL's first byte, once seen.
    nal_pts: Option<u64>,
    /// Where the next start-code scan resumes in `buf`.
    scan_from: usize,
    codec: Option<Codec>,
    open: Option<OpenAu>,
}

impl AccessUnitAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// The codec, once a parameter set has identified it.
    pub fn codec(&self) -> Option<Codec> {
        self.codec
    }

    /// Feed the next chunk. Returns every access unit it completed.
    pub fn push(&mut self, chunk: &[u8], pts90k: u64) -> Vec<AccessUnit> {
        let mut out = Vec::new();
        if chunk.is_empty() {
            return out;
        }
        if self.in_nal && self.nal_pts.is_none() {
            self.nal_pts = Some(pts90k);
        }
        self.buf.extend_from_slice(chunk);

        let mut consumed = 0;
        let mut i = self.scan_from;
        while i + 2 < self.buf.len() {
            if self.buf[i + 2] > 1 {
                i += 3;
            } else if self.buf[i] == 0 && self.buf[i + 1] == 0 && self.buf[i + 2] == 1 {
                if self.in_nal {
                    let nal = trim_trailing_zeros(&self.buf[consumed..i]).to_vec();
                    let pts = self.nal_pts.unwrap_or(pts90k);
                    self.accept_nal(&nal, pts, &mut out);
                }
                consumed = i + 3;
                self.in_nal = true;
                // A start code that ends the chunk leaves the payload's first
                // byte, and so its pts, to the next chunk.
                self.nal_pts = (consumed < self.buf.len()).then_some(pts90k);
                i = consumed;
            } else {
                i += 1;
            }
        }

        if self.in_nal {
            self.buf.drain(..consumed);
            self.scan_from = i - consumed;
        } else {
            // No start code yet: only a possible partial one needs keeping.
            let keep_from = self.buf.len().saturating_sub(2);
            self.buf.drain(..keep_from);
            self.scan_from = 0;
        }
        out
    }

    /// End of stream: emit the open access unit, including a trailing NAL
    /// that no start code has terminated.
    pub fn flush(&mut self) -> Vec<AccessUnit> {
        let mut out = Vec::new();
        if self.in_nal {
            let nal = trim_trailing_zeros(&self.buf).to_vec();
            if let Some(pts) = self.nal_pts {
                self.accept_nal(&nal, pts, &mut out);
            }
        }
        self.buf.clear();
        self.in_nal = false;
        self.nal_pts = None;
        self.scan_from = 0;
        if let (Some(open), Some(codec)) = (self.open.take(), self.codec) {
            out.push(open.close(codec));
        }
        out
    }

    fn accept_nal(&mut self, nal: &[u8], pts90k: u64, out: &mut Vec<AccessUnit>) {
        if nal.is_empty() || nal[0] & 0x80 != 0 {
            return;
        }
        let codec = match self.codec {
            Some(codec) => codec,
            None => match detect_codec(nal) {
                Some(codec) => {
                    self.codec = Some(codec);
                    codec
                }
                None => return,
            },
        };
        let info = NalInfo::of(codec, nal);

        let opens_au = info.starts_au || info.first_slice;
        if opens_au && self.open.as_ref().is_some_and(|au| au.has_vcl) {
            if let Some(done) = self.open.take() {
                out.push(done.close(codec));
            }
        }

        let slots = match codec {
            Codec::H265 => 3,
            Codec::H264 => 2,
        };
        let au = self.open.get_or_insert_with(|| OpenAu {
            data: Vec::new(),
            keyframe: false,
            has_vcl: false,
            params: vec![None; slots],
            pts90k,
        });
        au.data.extend_from_slice(&START_CODE);
        au.data.extend_from_slice(nal);
        au.has_vcl |= info.vcl;
        au.keyframe |= info.irap;
        if let Some(slot) = info.param_slot {
            au.params[slot] = Some(nal.to_vec());
        }
    }
}

/// A NAL ends with its rbsp stop bit, so trailing zero bytes are
/// `trailing_zero_8bits` or the leading zero of a 4-byte start code.
fn trim_trailing_zeros(bytes: &[u8]) -> &[u8] {
    let end = bytes.iter().rposition(|&b| b != 0).map_or(0, |p| p + 1);
    &bytes[..end]
}

/// Strip emulation prevention bytes (the 0x03 after each 0x00 0x00).
fn unescape_rbsp(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &byte in nal {
        if zeros == 2 && byte == 0x03 {
            zeros = 0;
            continue;
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    out
}

struct BitReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl BitReader<'_> {
    fn bit(&mut self) -> Option<u32> {
        let byte = self.bytes.get(self.pos / 8)?;
        let bit = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Some(u32::from(bit))
    }

    fn bits(&mut self, n: u32) -> Option<u32> {
        (0..n).try_fold(0, |acc, _| Some((acc << 1) | self.bit()?))
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.pos += n;
        (self.pos <= self.bytes.len() * 8).then_some(())
    }

    /// Exp-Golomb ue(v).
    fn ue(&mut self) -> Option<u32> {
        let mut leading = 0;
        while self.bit()? == 0 {
            leading += 1;
            if leading > 31 {
                return None;
            }
        }
        Some((1u32 << leading) - 1 + self.bits(leading)?)
    }
}

/// Display size from an H.265 SPS NAL (2-byte header included, no start
/// code), with the conformance window applied.
pub fn hevc_dimensions(sps: &[u8]) -> Option<(u32, u32)> {
    let rbsp = unescape_rbsp(sps);
    let mut r = BitReader {
        bytes: &rbsp,
        pos: 0,
    };
    r.skip(16)?; // NAL header
    r.skip(4)?; // sps_video_parameter_set_id
    let max_sub_layers_minus1 = r.bits(3)? as usize;
    r.skip(1)?; // sps_temporal_id_nesting_flag

    // profile_tier_level(1, max_sub_layers_minus1)
    r.skip(88)?; // general profile space .. general_inbld/reserved flag
    r.skip(8)?; // general_level_idc
    let mut sub_layers = Vec::with_capacity(max_sub_layers_minus1);
    for _ in 0..max_sub_layers_minus1 {
        sub_layers.push((r.bit()? == 1, r.bit()? == 1));
    }
    if max_sub_layers_minus1 > 0 {
        r.skip(2 * (8 - max_sub_layers_minus1))?; // reserved_zero_2bits
    }
    for (profile_present, level_present) in sub_layers {
        if profile_present {
            r.skip(88)?;
        }
        if level_present {
            r.skip(8)?;
        }
    }

    r.ue()?; // sps_seq_parameter_set_id
    let chroma_format_idc = r.ue()?;
    let separate_colour_plane = chroma_format_idc == 3 && r.bit()? == 1;
    let width = r.ue()?;
    let height = r.ue()?;
    let (mut left, mut right, mut top, mut bottom) = (0, 0, 0, 0);
    if r.bit()? == 1 {
        left = r.ue()?;
        right = r.ue()?;
        top = r.ue()?;
        bottom = r.ue()?;
    }
    let (sub_width, sub_height) = match (chroma_format_idc, separate_colour_plane) {
        (1, _) => (2, 2),
        (2, _) => (2, 1),
        _ => (1, 1),
    };
    let width = width.checked_sub(sub_width * left.checked_add(right)?)?;
    let height = height.checked_sub(sub_height * top.checked_add(bottom)?)?;
    (width > 0 && height > 0).then_some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEVC_IDR: &[u8] = include_bytes!("../../tests/fixtures/hevc-idr.h265");
    const HEVC_CRA_AUD: &[u8] = include_bytes!("../../tests/fixtures/hevc-cra-aud.h265");
    const HEVC_SLICES: &[u8] = include_bytes!("../../tests/fixtures/hevc-slices.h265");
    const HEVC_SWITCH: &[u8] = include_bytes!("../../tests/fixtures/hevc-switch.h265");
    const H264_IDR: &[u8] = include_bytes!("../../tests/fixtures/h264-idr.h264");

    fn assemble_chunked(bytes: &[u8], chunk: usize) -> Vec<AccessUnit> {
        let mut assembler = AccessUnitAssembler::new();
        let mut units = Vec::new();
        for piece in bytes.chunks(chunk) {
            units.extend(assembler.push(piece, 0));
        }
        units.extend(assembler.flush());
        units
    }

    fn assemble(bytes: &[u8]) -> Vec<AccessUnit> {
        assemble_chunked(bytes, bytes.len())
    }

    fn sps_of(unit: &AccessUnit) -> Option<&[u8]> {
        let params = unit.params.as_ref()?;
        params
            .nals
            .iter()
            .find(|nal| (nal[0] >> 1) & 0x3f == 33)
            .map(Vec::as_slice)
    }

    #[test]
    fn assembles_one_au_per_frame() {
        for (name, fixture) in [
            ("hevc-idr", HEVC_IDR),
            ("hevc-cra-aud", HEVC_CRA_AUD),
            ("hevc-slices", HEVC_SLICES),
            ("h264-idr", H264_IDR),
        ] {
            let whole = assemble(fixture);
            assert_eq!(whole.len(), 60, "{name}");
            assert_eq!(assemble_chunked(fixture, 1000), whole, "{name}");
        }
        assert_eq!(assemble(HEVC_SWITCH).len(), 120);
        assert_eq!(assemble_chunked(HEVC_SWITCH, 1000), assemble(HEVC_SWITCH));
    }

    #[test]
    fn byte_at_a_time_matches_one_chunk() {
        assert_eq!(assemble_chunked(HEVC_CRA_AUD, 1), assemble(HEVC_CRA_AUD));
    }

    #[test]
    fn marks_idr_and_cra_as_keyframes() {
        for (name, fixture) in [("hevc-idr", HEVC_IDR), ("hevc-cra-aud", HEVC_CRA_AUD)] {
            let units = assemble(fixture);
            let keyframes = units.iter().filter(|unit| unit.keyframe).count();
            assert!(keyframes >= 2, "{name}: {keyframes} keyframes");
            assert!(units[0].keyframe, "{name}");
            let params = units[0].params.as_ref().expect("AU 0 carries params");
            assert_eq!(params.codec, Codec::H265);
            assert_eq!(params.nals.len(), 3, "{name}: VPS, SPS, PPS");
        }
    }

    #[test]
    fn cra_fixture_has_a_cra_keyframe() {
        let units = assemble(HEVC_CRA_AUD);
        let has_cra = units
            .iter()
            .any(|unit| unit.keyframe && nal_types(&unit.data).any(|b0| (b0 >> 1) & 0x3f == 21));
        assert!(has_cra);
    }

    #[test]
    fn multi_slice_pictures_stay_one_au() {
        let units = assemble(HEVC_SLICES);
        assert_eq!(units.len(), 60);
        let slices = nal_types(&units[1].data)
            .filter(|b0| (b0 >> 1) & 0x3f < 32)
            .count();
        assert_eq!(slices, 4, "the fixture has 4 slices per picture");
    }

    #[test]
    fn reads_hevc_dimensions() {
        let units = assemble(HEVC_IDR);
        let sps = sps_of(&units[0]).expect("first AU has an SPS");
        assert_eq!(hevc_dimensions(sps), Some((1280, 720)));

        let units = assemble(HEVC_SWITCH);
        let after = units[60..]
            .iter()
            .find_map(sps_of)
            .expect("an SPS after the switch");
        assert_eq!(hevc_dimensions(after), Some((720, 1280)));
    }

    #[test]
    fn hevc_dimensions_rejects_truncated_sps() {
        let units = assemble(HEVC_IDR);
        let sps = sps_of(&units[0]).unwrap();
        assert_eq!(hevc_dimensions(&sps[..6]), None);
        assert_eq!(hevc_dimensions(&[]), None);
    }

    #[test]
    fn detects_h264() {
        let mut assembler = AccessUnitAssembler::new();
        let mut units = assembler.push(H264_IDR, 0);
        units.extend(assembler.flush());
        assert_eq!(assembler.codec(), Some(Codec::H264));
        assert_eq!(units.len(), 60);
        assert!(units[0].keyframe);
        let params = units[0].params.as_ref().expect("AU 0 carries params");
        assert_eq!(params.codec, Codec::H264);
        assert_eq!(params.nals.len(), 2, "SPS, PPS");
    }

    #[test]
    fn data_uses_four_byte_start_codes() {
        // VPS, SPS, PPS and an IDR slice with 3-byte start codes, then the
        // first slice of a second picture.
        let stream = [
            &[0, 0, 1, 0x40, 0x01, 0xaa][..],
            &[0, 0, 1, 0x42, 0x01, 0xbb],
            &[0, 0, 1, 0x44, 0x01, 0xcc],
            &[0, 0, 1, 0x26, 0x01, 0x80, 0xdd],
            &[0, 0, 1, 0x02, 0x01, 0x80, 0xee],
        ]
        .concat();
        let units = assemble(&stream);
        assert_eq!(units.len(), 2);
        assert_eq!(
            units[0].data,
            [
                &[0, 0, 0, 1, 0x40, 0x01, 0xaa][..],
                &[0, 0, 0, 1, 0x42, 0x01, 0xbb],
                &[0, 0, 0, 1, 0x44, 0x01, 0xcc],
                &[0, 0, 0, 1, 0x26, 0x01, 0x80, 0xdd],
            ]
            .concat()
        );
        assert!(units[0].keyframe);
        assert_eq!(
            units[0].params.as_ref().unwrap().nals,
            vec![
                vec![0x40, 0x01, 0xaa],
                vec![0x42, 0x01, 0xbb],
                vec![0x44, 0x01, 0xcc]
            ]
        );
        assert_eq!(units[1].data, [0, 0, 0, 1, 0x02, 0x01, 0x80, 0xee]);
        assert!(!units[1].keyframe);
        assert_eq!(units[1].params, None);
    }

    #[test]
    fn drops_nals_until_the_codec_is_known() {
        let stream = [
            &[0, 0, 0, 1, 0x02, 0x01, 0x80, 0x11][..],
            &[0, 0, 0, 1, 0x40, 0x01, 0xaa],
            &[0, 0, 0, 1, 0x26, 0x01, 0x80, 0xdd],
        ]
        .concat();
        let units = assemble(&stream);
        assert_eq!(units.len(), 1);
        assert_eq!(
            units[0].data,
            [
                &[0, 0, 0, 1, 0x40, 0x01, 0xaa][..],
                &[0, 0, 0, 1, 0x26, 0x01, 0x80, 0xdd],
            ]
            .concat()
        );
    }

    #[test]
    fn pts_comes_from_the_chunk_holding_the_first_nal() {
        let mut assembler = AccessUnitAssembler::new();
        let mut units = Vec::new();
        // The start code ends this chunk, so the VPS's first byte is in the next.
        units.extend(assembler.push(&[0, 0, 0, 1], 100));
        units.extend(assembler.push(&[0x40, 0x01, 0xaa, 0, 0, 0, 1, 0x26, 0x01], 200));
        units.extend(assembler.push(&[0x80, 0xdd, 0, 0, 0, 1, 0x02], 300));
        units.extend(assembler.push(&[0x01, 0x80, 0xee], 400));
        units.extend(assembler.flush());
        let pts: Vec<u64> = units.iter().map(|unit| unit.pts90k).collect();
        assert_eq!(pts, vec![200, 300]);
    }

    /// First byte of every NAL in a 4-byte-start-code buffer.
    fn nal_types(data: &[u8]) -> impl Iterator<Item = u8> + '_ {
        data.windows(5)
            .filter(|w| w[..4] == [0, 0, 0, 1])
            .map(|w| w[4])
    }
}
