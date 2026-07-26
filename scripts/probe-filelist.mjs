/**
 * Probe how firmware 1.0.238 lists media. The HTTP directory autoindex is now
 * disabled (403), so the gallery can't scrape it. This tests the control-session
 * GET_FILE_LIST command (code 13) and, while the session is held (which
 * IP-authorizes HTTP), what the camera actually serves.
 *
 *   node scripts/probe-filelist.mjs [--host 192.168.42.1]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fieldVarint, LunaSession, CONTROL_PORT } from "./lib/ucd2.mjs";
import { annotate, decodeRaw, renderRows } from "./lib/protobuf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "luna-protocol-schema.json"), "utf8"));
const HOST = process.argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? "192.168.42.1";
const GET_FILE_LIST = 13;

const listBody = (mediaType, start, limit) =>
  Buffer.concat([fieldVarint(1, mediaType), fieldVarint(2, start), fieldVarint(3, limit)]);

const asString = (buf) => (Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf));

const session = new LunaSession(HOST, CONTROL_PORT);
await session.connect();
console.log("✓ control session open to", HOST, "\n");

for (const [name, mt] of [
  ["VIDEO_AND_PHOTO", 2],
  ["PHOTO", 1],
  ["VIDEO", 0],
]) {
  console.log(`===== GET_FILE_LIST media_type=${name}(${mt}) start=0 limit=50 =====`);
  try {
    const frame = await session.send(GET_FILE_LIST, listBody(mt, 0, 50));
    const raw = decodeRaw(frame.body);
    console.log("raw fields:", JSON.stringify(raw));
    try {
      console.log(renderRows(annotate(frame.body, "insta360.messages.GetFileListResp", schema)));
    } catch {
      /* shape may differ on new firmware */
    }

    // If the response carries a uri (field 1), fetch it — the open session
    // should authorize HTTP from this machine.
    const uriField = raw.find((f) => f.field === 1 && Buffer.isBuffer(f.value));
    if (uriField) {
      const uri = asString(uriField.value);
      const url = uri.startsWith("http")
        ? uri
        : `http://${HOST}${uri.startsWith("/") ? "" : "/"}${uri}`;
      console.log("→ uri:", uri, "\n→ fetching:", url);
      try {
        const r = await fetch(url);
        const text = await r.text();
        console.log(`   HTTP ${r.status} (${text.length} bytes), first 400:\n`, text.slice(0, 400));
      } catch (e) {
        console.log("   fetch failed:", String(e));
      }
    }
  } catch (e) {
    console.log("send failed:", String(e));
  }
  console.log();
}

console.log("===== raw HTTP while the session is held (should be authorized) =====");
for (const p of ["/DCIM/", "/storage_internal/DCIM/", "/"]) {
  try {
    const r = await fetch(`http://${HOST}${p}`);
    console.log(`${p} -> HTTP ${r.status}`);
  } catch (e) {
    console.log(`${p} -> ${String(e)}`);
  }
}

session.close();
process.exit(0);
