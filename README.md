# gdrive-cli

Truy cập Google Sheets / Docs / Slides / Drive bằng **service account**, cho Claude Code và
cho script Node — **zero dependency**.

Cài **một** plugin cho Claude Code — skill, MCP tool và CLI gói chung, dùng được ở **mọi repo**.
Yêu cầu Node.js >= 18.17.

```
/plugin marketplace add dangchison/gdrive-cli
/plugin install gdrive@gdrive-cli
```

Rồi chạy skill `/gdrive-setup` để trỏ tới file JSON key của service account.
**Private key không bao giờ đi qua cuộc hội thoại** — bạn chỉ đưa đường dẫn, CLI tự đọc.

Cấu hình nằm trong thư mục data của plugin (`~/.claude/plugins/data/…`, chmod 600), tự xoá khi
gỡ plugin. **Không đụng `settings.json`, không rải file khắp `~/.claude`.**

## Claude dùng nó thế nào

Sau khi cài, Claude có sẵn các MCP tool — không cần allow-rule, không phụ thuộc skill có kích
hoạt đúng hay không:

| Tool | Việc |
|---|---|
| `gdrive_sheet_read` | Google Sheets **và** `.xlsx` trên Drive; luôn trả kèm danh sách tab |
| `gdrive_read_document` | Docs, Slides, `.docx`, `.pptx`, `.csv`, `.txt` |
| `gdrive_file_info` | File này là gì, đọc bằng tool nào |
| `gdrive_list` · `gdrive_download` | Tìm và tải file |
| `gdrive_sheet_write` · `gdrive_upload` | Chỉ hiện ở chế độ `readwrite` |

Mặc định là **readonly**: hai tool ghi bị **ẩn hẳn** khỏi danh sách — model không gọi được thứ
nó không nhìn thấy. Bật ghi qua bản plugin:
`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" init --mode readwrite`.

## Lệnh

CLI vẫn còn cho việc gọi tay và cho script. Khi cài qua plugin, chạy bằng file trong plugin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" read  <url> [--sheet <tên|gid>] [--range A1:E50] [--json]
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" doc   <url> [--format markdown|text] [--notes]
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" info  <url>
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" ls    [<url-thư-mục>] [--name-contains …]
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" get   <url> --out <path>
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" put   <file> --folder <url> [--share none|anyone-reader]
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" write <url> --set L5=PASSED --set L6=FAILED
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" init
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" uninstall [--purge]   # dọn bản cài cũ; --purge xoá config plugin chứa private key
```

Nếu cài qua npm global thì mới có lệnh `gdrive`:

```bash
npm i -g gdrive-cli
gdrive read <url>
gdrive init --mode readwrite
```

Mọi lệnh nhận **thẳng URL dán vào** — tự bóc file id và gid. `read` luôn in kèm danh sách
tất cả các tab, nên đoán nhầm tab thì gọi lại được ngay, không cần lệnh phụ để dò.

Mặc định cài ở chế độ **readonly**: `write` và `put` bị từ chối ngay tại chỗ. Với service
account, token được cấp scope `.readonly`; với ADC/gcloud, token giữ nguyên quyền đã được cấp
cho tài khoản đó. Bật ghi bằng `init --mode readwrite`.

## Vì sao zero dependency

| | |
|---|---|
| `googleapis` | **207 MB** giải nén |
| gói này | 0 dependency |

Auth là JWT RS256 tự ký bằng `node:crypto` rồi đổi lấy access token (~170 dòng). Đọc
`.xlsx/.docx/.pptx` là ZIP + XML, dùng `zlib.inflateRawSync` có sẵn trong Node (~600 dòng).
Không có gì cần cài thêm — kể cả `python3` + `openpyxl` mà cách làm cũ phải dựa vào.

## Đọc được những gì

| Định dạng | Đọc | Cách |
|---|---|---|
| Google Sheets | ✅ | Sheets API (**không** export CSV — CSV chỉ ra tab đầu) |
| Google Docs | ✅ | `files.export` → `text/markdown` |
| Google Slides | ✅ | export `.pptx` rồi tự parse (export `text/plain` mất ranh giới slide) |
| `.xlsx` / `.xlsm` | ✅ | ZIP + XML |
| `.docx` | ✅ | ZIP + XML (kèm bảng → markdown) |
| `.pptx` | ✅ | ZIP + XML, giữ từng slide |
| `.csv` `.txt` `.md` `.json` | ✅ | tải thẳng |
| PDF | ⚠️ tải về | Không parse — tải xuống rồi để công cụ đọc PDF xử lý |
| `.doc` `.xls` `.ppt` (đời cũ) | ❌ | Từ chối kèm hướng dẫn: mở trong Drive → File → Save as Google Docs |

`.doc/.xls/.ppt` là OLE2/CFB nhị phân. Parser đúng tốn hàng nghìn dòng, còn parser nửa vời
trả ra rác *trông có vẻ đúng* — kiểu hỏng tệ nhất khi kết quả sẽ được dùng để ra quyết định.

## Credential

Tìm theo thứ tự, dừng ở cái đầu tiên có:

1. Tham số truyền thẳng vào `createClient({credentials})`
2. `GOOGLE_SERVICE_ACCOUNT_JSON` (JSON thô hoặc base64) ← thân thiện CI nhất
3. `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`
4. `DRIVE_SERVICE_ACCOUNT_EMAIL` + `DRIVE_PRIVATE_KEY`
5. `GOOGLE_APPLICATION_CREDENTIALS` (đường dẫn file key)
6. Config của plugin — `~/.claude/plugins/data/…/config.json` (chmod 600); rơi về
   `~/.claude/gdrive.json` nếu bạn từng cài kiểu cũ
7. ADC của gcloud — **opt-in**, chỉ chạy sau `init --adc`
8. `gcloud auth print-access-token` — **opt-in**, chỉ chạy sau `init --adc`

Env đứng trước file config là cố ý: CI không có `~/.claude` nhưng có secret trong env.
ADC/gcloud bị tắt mặc định vì chúng chạy bằng danh tính cá nhân của người dùng, không phải
service account riêng của plugin.

> **Service account là một danh tính riêng, có email riêng.** Nó không thấy gì cho tới khi
> bạn Share file/folder cho email đó — Viewer để đọc, Editor để ghi.

> **Service account không có dung lượng My Drive.** Mọi thao tác GHI file vào My Drive đều
> thất bại `403 storageQuotaExceeded`, kể cả khi đã share Editor. Muốn upload thì phải dùng
> Shared Drive.

## Dùng như thư viện

```js
import { createClient, readSheet, parseGoogleUrl } from 'gdrive-cli';

const client = createClient({ mode: 'readonly' });
const { id, gid } = parseGoogleUrl('https://docs.google.com/spreadsheets/d/…/edit#gid=123');
const { rows, sheet, sheets } = await readSheet(client, id, { gid });
```

Có sẵn facade mang hình dạng client `googleapis` để migrate code cũ mà không phải sửa chỗ gọi:

```js
import { createSheetsCompatClient } from 'gdrive-cli/sheets-compat';

const sheets = createSheetsCompatClient({ mode: 'readwrite' });
await sheets.spreadsheets.values.get({ spreadsheetId, range: "'Tab'!A1:C3" }); // → {data}
```

## Test

```bash
node --test
```

179 test, không cần mạng và không cần credential: chữ ký JWT được verify bằng keypair sinh
tại chỗ, fixture ZIP/OOXML dựng in-memory bằng `zlib.deflateRawSync`, và cả luồng
init/uninstall chạy trên một HOME tạm. Riêng MCP server được chạy như tiến trình con thật
và feed byte-stream JSON-RPC vào — bắt được cả ca stdout bị nhiễm thứ không phải JSON.

Ngoài ra bộ đọc `.xlsx` đã được đối chiếu với `python3` + `openpyxl` trên 6 file thật tải từ
Drive: **3859 ô, 0 lệch**.

## Giấy phép

MIT
