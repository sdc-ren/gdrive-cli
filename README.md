# gdrive-cli

gdrive-cli cho trợ lý AI đọc và ghi Google Sheets, Docs, Slides và file Office trên Drive bằng
một service account riêng, và chỉ trong những folder bạn cho phép. Nó là một MCP server chạy
trên máy bạn, dùng được với Claude Code, Codex, GitHub Copilot (VS Code và CLI), Cursor, Kiro và
các client MCP khác, kèm một CLI và một thư viện Node cho script. Gói không có dependency nào,
chỉ cần Node.js 18.17 trở lên.

## Phạm vi folder

Service account chỉ thấy những file đã được share cho email của nó. Từ v0.4, plugin còn tự giới
hạn thêm một lớp: mọi tool chỉ đọc và ghi trong danh sách folder bạn khai báo. Danh sách nằm
trong file config (chmod 600):

```json
{
  "clientEmail": "…",
  "privateKey": "…",
  "folders": [
    { "id": "1AbC…", "name": "bao-cao", "access": "read" },
    { "id": "1XyZ…", "name": "test-run", "access": "write" }
  ]
}
```

`name` là tên gợi nhớ (chữ thường, số, gạch nối) để model gọi `test-run` thay vì dán id.
`access` là `read` hoặc `write`.

Ba quy tắc áp dụng cho mọi tool:

1. Một file thuộc phạm vi khi chính nó hoặc một folder cha của nó (ở mọi độ sâu) nằm trong danh
   sách. File ngoài danh sách bị từ chối với lỗi `ngoài phạm vi`, kể cả khi service account đọc
   được file đó.
2. Danh sách rỗng thì mọi tool từ chối và hướng dẫn chạy `gdrive folder add`.
3. Ba tool ghi (`sheet_write`, `drive_create`, `drive_move`) chỉ xuất hiện trong danh sách tool
   khi có ít nhất một folder `write`. Không có folder `write` thì token chỉ xin scope
   `.readonly`.

Quản lý danh sách bằng CLI:

```bash
gdrive folder add <url|id> [--name <tên>] [--access read|write]   # mặc định read
gdrive folder list
gdrive folder set <tên> --access read|write
gdrive folder remove <tên>
```

`folder add` gọi Drive để chắc rằng service account thấy folder và đó đúng là folder. Chưa share
thì lệnh báo cần share cho email nào. Không truyền `--name` thì tên lấy từ tên folder trên Drive.
Server đang chạy nạp lại danh sách ở request kế tiếp. Khi tool ghi xuất hiện hoặc biến mất, server
báo client rằng bộ tool đã đổi; client không hỗ trợ thông báo này thì cần mở session mới.

Trong CI, biến `GDRIVE_FOLDERS` thay cho khoá `folders` trong config:

```bash
GDRIVE_FOLDERS="test-run=1XyZ…:write,bao-cao=1AbC…:read"
```

Các lệnh CLI `read`, `doc`, `info`, `ls`, `get`, `write`, `put` cũng tuân danh sách này khi nó có
mục nào đó. Script dùng thư viện (`createClient`) không bị giới hạn.

## Token

Đo ngày 2026-10-01 bằng tiktoken `o200k_base` trên Drive thật, so với bản v0.3 và connector
Google Drive có sẵn trong Claude. Số của connector ở hai dòng đọc file được ước từ output thật
của nó.

| Mục | v0.3 | v0.4 | Connector Google Drive của Claude |
|---|---|---|---|
| Schema tool, chỉ đọc | 764 (5 tool) + 305 instructions | 265 (2 tool) + 196 instructions | 2.337 (6 tool đọc) |
| Schema tool, có quyền ghi | 1.142 (7 tool) | 561 (5 tool) | 3.610 (11 tool) |
| Đọc cả tab Google Sheet (25 dòng × 6 cột, tiếng Việt) | 7.334 | 6.090 | chưa đo |
| Đọc 10 dòng đầu (`limit: 10`) | không có | 2.599 | không có tuỳ chọn này |
| Đọc xlsx (1 tab, 23 dòng) | 3.080 | 2.261 | khoảng 2.829 |
| Đọc docx khoảng 10.000 ký tự | 3.837 | 3.604 | khoảng 3.650 |
| Liệt kê 10 file | 1.401 | 957 | chưa đo; mặc định kèm snippet tới 5.000 ký tự mỗi file |

Tokenizer của Claude cho ra số khác tiktoken, còn tỷ lệ giữa các cột thì giữ nguyên. Phần tiết
kiệm lớn nhất nằm ở schema, vì schema được gửi kèm mọi lượt hội thoại. Với sheet lớn, `columns`,
`where` và `limit` giúp model chỉ lấy phần cần đọc.

Tự đo ước lượng (không cần tokenizer, tính theo số byte):

```bash
npm run bench
```

CI đỏ khi schema vượt 700 token ước lượng.

## Ổn định

- Mỗi request có timeout 30 giây.
- Lỗi tạm thời được thử lại theo `Retry-After` của Google, có jitter. MCP server thử tối đa 4
  lần, CLI 2 lần, thư viện mặc định không thử lại.
- Drive báo giới hạn tốc độ bằng 403 `rateLimitExceeded`. Lỗi này giờ được thử lại như 429.
- Request không idempotent (thêm dòng, tạo file) không gửi lại khi mất câu trả lời giữa chừng.
  Tool báo `Chưa chắc đã ghi` để model đọc lại trước khi thử, tránh ghi trùng.
- Token bị thu hồi giữa chừng (401) thì lấy token mới và thử đúng một lần.
- MCP server cache metadata Drive và Sheets 5 phút, cache kết quả kiểm phạm vi 10 phút. Cache
  bị xoá khi chính server tạo, đổi tên hay di chuyển file, và khi danh sách folder đổi.
- Tối đa 4 request tới Google chạy cùng lúc.
- `GDRIVE_DEBUG=1` in từng request (method, đường dẫn, kết quả, thời gian, lần thử) ra stderr.

Độ trễ đo cùng ngày qua MCP server thật, server đã khởi động, tính bằng mili giây:

| Thao tác | v0.3 | v0.4 |
|---|---|---|
| Đọc sheet lần đầu (lấy token và metadata) | 2.557 | 2.278 |
| Đọc lại cùng sheet | 1.300-1.500 | 359-390 |
| Đọc 10 dòng của sheet | 1.445 | 499 |
| Đọc xlsx lần thứ hai | 1.500 | 761 |
| Đọc docx | 1.750-2.360 | 2.138-2.292 |
| Liệt kê 10 file | 764 | 1.135 |
| 5 lần đọc song song (10 dòng mỗi lần) | 1.431 | 887 |
| Khởi động tới `initialize` | 47 | khoảng 45 |

Docx được export lại mỗi lần đọc vì nội dung file không được cache. Liệt kê chậm hơn v0.3 vì
có thêm một lần `files.get` để kiểm folder đó có nằm trong phạm vi hay không. Connector của
Claude không lộ thời gian nên không có cột so sánh.

## Cài cho Claude Code

```
/plugin marketplace add sdc-ren/gdrive-cli
/plugin install gdrive@gdrive-cli
```

Sau đó chạy skill `/gdrive-setup`. Skill hỏi đường dẫn tới file JSON key của service account
rồi hỏi những folder nào được đọc, folder nào được ghi. CLI tự đọc file key, nên private key
không đi qua cuộc hội thoại.

Plugin lưu cấu hình trong thư mục data của nó (`~/.claude/plugins/data/…`, chmod 600) và thư mục
này bị xoá khi gỡ plugin. Plugin không sửa `settings.json`.

## Cài cho Codex, Copilot, Cursor, Kiro

```bash
npm i -g github:sdc-ren/gdrive-cli
gdrive init --sa-json ~/keys/service-account.json
gdrive folder add "https://drive.google.com/drive/folders/…" --access write
gdrive install --client cursor          # hoặc codex, copilot, copilot-cli, kiro; nhiều client: cursor,codex
```

Khởi động lại client để nạp các tool `drive_*`. Nếu máy đã có plugin Claude, `init` ghi đè file
credential đang dùng thay vì tạo bản thứ hai.

`install` chỉ thêm hoặc thay khoá `gdrive` trong file config của client. Các server khác giữ
nguyên, chạy lại lệnh không thay đổi gì thêm, và lệnh không ghi credential vào file đó.

| `--client` | Cấp user (mặc định) | `--project` (repo đang đứng) |
|---|---|---|
| `codex` | `~/.codex/config.toml` | `.codex/config.toml` (Codex chỉ đọc khi project đã trust) |
| `copilot` (VS Code) | `mcp.json` trong thư mục User của VS Code (profile mặc định) | `.vscode/mcp.json` |
| `copilot-cli` | `~/.copilot/mcp-config.json` | Không hỗ trợ |
| `cursor` | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| `kiro` | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` |

Ở cấp user, config chứa đường dẫn tuyệt đối tới `node` và tới server, vì app mở từ Dock hay
Start menu thường không có PATH của nvm hoặc Homebrew. Đổi phiên bản Node thì chạy lại
`install`. `gdrive status` báo đỏ khi đường dẫn trong config không còn tồn tại.

`--project` ghi lệnh `gdrive mcp`, không chứa đường dẫn trên máy bạn, nên file có thể commit.
Ai dùng repo cũng cần cài gdrive-cli global.

`--skill` cài thêm Agent Skill (`SKILL.md`) hướng dẫn chọn tool và xử lý lỗi vào
`~/.agents/skills/gdrive` (Kiro dùng `~/.kiro/skills/gdrive`). Server cũng gửi một bản rút gọn
qua trường MCP `instructions` cho client nào đọc trường này.

Nếu file config có comment (JSONC, hay gặp ở VS Code) hoặc là TOML viết theo kiểu khó sửa an
toàn, `install` để nguyên file và in ra đoạn cấu hình để bạn tự dán. Client chưa có trong bảng
thì trỏ thẳng vào lệnh `gdrive mcp` (MCP qua stdio).

Gỡ đăng ký mà vẫn giữ credential: `gdrive uninstall --client cursor [--project]`.

## Năm tool MCP

| Tool | Việc |
|---|---|
| `drive_ls` | Không tham số: các folder được phép kèm quyền. Có `path`: nội dung một folder, lọc theo tên bằng `query` |
| `drive_read` | Đọc mọi loại file được hỗ trợ: Sheet và xlsx ra TSV (lọc `columns`, `where`, phân trang `offset`/`limit`), Doc, Slides, docx, pptx, txt ra markdown |
| `sheet_write` | Ghi ô (`{"L5": "PASS"}`) và/hoặc thêm dòng vào Google Sheet |
| `drive_create` | Tạo folder, Google Doc từ markdown, Google Sheet từ CSV/TSV |
| `drive_move` | Đổi tên, chuyển file sang folder khác (cả hai folder phải có quyền `write`) |

Mọi `target` nhận tên gợi nhớ (`test-run`), đường dẫn `test-run/sub/file`, link Google dán
nguyên, hoặc id. Kết quả là văn bản thuần. Dòng đầu bắt đầu bằng `#` mô tả ngữ cảnh, lỗi bắt
đầu bằng `✗`.

Ví dụ `drive_read` với `{"target": "test-run/TC_login", "columns": ["ID", "Ghi chú"], "where": {"Trạng thái": "FAIL"}}`:

```
# TC_login › Sheet1 · tabs: Sheet1,Data · rows 1-2/2
ID	Ghi chú
TC-07	Sai thông báo khi mật khẩu rỗng
TC-12	Timeout ở bước xác thực OTP
```

Dòng đầu luôn liệt kê mọi tab. Còn dòng chưa đọc thì dòng đầu có thêm `next=<offset>`, và model
đọc tiếp bằng `offset`. Mặc định 200 dòng một trang, tối đa 2000.

## Đọc được những gì

| Định dạng | Đọc | Cách |
|---|---|---|
| Google Sheets | Có | Sheets API. Export CSV chỉ lấy được tab đầu nên không dùng |
| Google Docs | Có | `files.export` sang `text/markdown` |
| Google Slides | Có | Export `.pptx` rồi tự đọc. Export `text/plain` làm mất ranh giới slide |
| `.xlsx` / `.xlsm` | Có | ZIP + XML |
| `.docx` | Có | ZIP + XML, bảng chuyển thành markdown |
| `.pptx` | Có | ZIP + XML, giữ từng slide theo thứ tự trong `presentation.xml` |
| `.csv` `.txt` `.md` `.json` | Có | Tải thẳng |
| PDF | Chỉ tải về | `drive_read` trả một dòng metadata, tải bằng `gdrive get` |
| `.doc` `.xls` `.ppt` | Không | Mở trong Drive, chọn File > Save as Google Docs/Sheets/Slides |

Các định dạng Office đời cũ là file nhị phân OLE2. Một parser đúng cho chúng dài hàng nghìn
dòng, còn parser làm dở thường trả ra chữ trông hợp lý nhưng sai. Gói chọn báo lỗi rõ ràng.
File trên 50 MB và file ZIP giải nén ra hơn 256 MB bị từ chối.

Auth là JWT RS256 tự ký bằng `node:crypto`. Bộ đọc OOXML dùng `zlib.inflateRawSync` có sẵn
trong Node.

## Giới hạn của service account

Service account có email riêng và không thấy file nào cho tới khi bạn share cho email đó
(Viewer để đọc, Editor để ghi). Nó cũng không có dung lượng My Drive, nên file mới chỉ tạo được
trong folder trên Shared Drive.

Kết quả thử ngày 2026-10-01 trên một folder My Drive đã share Editor cho service account:

| Thao tác | My Drive | Shared Drive |
|---|---|---|
| Tạo folder con | Chạy (folder không tốn dung lượng) | chưa đo |
| Tạo Google Doc từ markdown | Lỗi 403 `storageQuotaExceeded` | chưa đo |
| Tạo Google Sheet từ CSV | Lỗi 403 `storageQuotaExceeded` | chưa đo |
| Đổi tên file | Chạy | chưa đo |
| Chuyển file giữa hai folder được share | Chạy | chưa đo |
| Ghi ô, thêm dòng vào Sheet có sẵn | chưa đo | chưa đo |

Vì vậy `drive_create` với `kind: doc` hoặc `sheet` kiểm tra folder đích trước. Folder nằm trên
My Drive thì tool trả lỗi giải thích cần Shared Drive và không gọi API tạo file. Người dùng vẫn
có thể tự tạo Sheet trong folder rồi để model ghi vào đó bằng `sheet_write`.

Một số việc gdrive-cli không làm: sửa nội dung Google Docs, quản lý quyền share, xoá file, trích
chữ từ PDF.

Thêm vài điều cần biết trước khi chọn:

- Lần đầu phải tạo GCP project, bật Drive API và Sheets API, tạo service account và tải file
  key, mất khoảng 5 phút.
- Tổ chức dùng Google Workspace có thể chặn share ra ngoài domain hoặc cấm tạo key cho service
  account. Khi đó cần quản trị viên mở quyền.
- File key là một secret dài hạn nằm trên đĩa (chmod 600). Lộ file đó thì phải thu hồi key trong
  GCP Console.
- Gói chưa có trên npm (tên `gdrive-cli` ở đó thuộc người khác), phải cài từ GitHub.

### So với connector Google Drive của Claude

Connector Google Drive có sẵn trong Claude đăng nhập bằng tài khoản Google của bạn qua OAuth và
thấy mọi file tài khoản đó thấy. Nó tìm kiếm trên toàn Drive, đọc nội dung, xem metadata và
quyền, tạo, sửa, copy, share và chuyển file vào thùng rác. Connector chỉ chạy trong các sản phẩm
của Claude.

| | gdrive-cli | Connector Google Drive của Claude |
|---|---|---|
| Danh tính | Service account riêng | Tài khoản Google của bạn (OAuth) |
| AI thấy gì | Các folder trong danh sách, đã share cho service account | Mọi thứ tài khoản bạn thấy |
| Cài đặt | GCP project, file key, share và khai báo từng folder | Bấm kết nối, đăng nhập |
| Client | Claude Code, Codex, Copilot, Cursor, Kiro, client MCP bất kỳ | Claude |
| Script và CI | Có (CLI, thư viện, biến môi trường) | Không |
| Ghi | Ô và dòng trong Sheets, tạo folder/Doc/Sheet, đổi tên, chuyển file | Tạo, sửa, copy, share, xoá file |
| Schema tool (tiktoken) | 561 token khi có quyền ghi | 3.610 token |
| Chạy ở đâu | Trên máy bạn, gọi thẳng Google API | Qua hạ tầng của Claude |

Chọn gdrive-cli khi bạn muốn giới hạn chính xác những folder AI đọc được, khi dùng client khác
Claude, hoặc khi cần chạy trong script và CI. Chọn connector khi bạn chỉ chat trong Claude, muốn
AI tìm được mọi file của mình, cần share file, hoặc không muốn đụng tới GCP.

## Nâng cấp từ v0.3

Sau khi cập nhật, bắt buộc khai báo ít nhất một folder. Chưa có folder nào thì mọi tool MCP từ
chối:

```bash
gdrive folder add <link-folder> --access read
gdrive folder add <link-folder-ghi> --access write
```

Tên tool đổi như sau. Mọi tool cũ có chung tiền tố `gdrive_`; cột v0.3 ghi phần tên sau tiền tố
đó.

| v0.3 (bỏ tiền tố `gdrive_`) | v0.4 |
|---|---|
| `sheet_read` | `drive_read` |
| `read_document` | `drive_read` |
| `file_info` | `drive_read` (file không đọc được thì trả một dòng metadata) |
| `list` | `drive_ls` |
| `sheet_write` | `sheet_write` |
| `download` | bỏ khỏi MCP; dùng CLI `gdrive get` |
| `upload` | bỏ khỏi MCP; dùng CLI `gdrive put` |

Prompt, skill hay tài liệu riêng nào nhắc tên cũ thì cần sửa theo bảng trên.

Những thứ khác thay đổi:

- Ai đã chạy `gdrive install --client` không phải chạy lại. Entry MCP trong config của client
  vẫn trỏ vào cùng lệnh.
- Khoá `mode` (`readonly`/`readwrite`) trong config không còn tác dụng khi đã có `folders`.
  Quyền ghi đặt theo từng folder bằng `gdrive folder set <tên> --access write`.
- Kết quả tool là văn bản thuần (TSV, markdown) thay cho JSON.
- `createClient()` không trả `credentials` nữa. Cần email của service account thì đọc
  `client.identity.clientEmail`.

Danh sách đầy đủ ở [CHANGELOG.md](CHANGELOG.md).

## Lệnh

```bash
gdrive read  <url> [--sheet <tên|gid>] [--range A1:E50] [--json]
gdrive doc   <url> [--format markdown|text] [--notes]
gdrive info  <url>
gdrive ls    [<url-thư-mục>] [--name-contains …]
gdrive get   <url> --out <path>
gdrive put   <file> --folder <url> [--share none|anyone-reader]
gdrive write <url> --set L5=PASSED --set L6=FAILED
gdrive folder add <url|id> [--name <tên>] [--access read|write]
gdrive folder list | set <tên> --access read|write | remove <tên>
gdrive init  [--sa-json <file>|--adc] [--mode readonly|readwrite]
gdrive status
gdrive install   --client <tên> [--project] [--skill]
gdrive uninstall --client <tên> [--project]   # gỡ đăng ký khỏi client
gdrive uninstall [--purge]                    # dọn bản cài cũ; --purge xoá cả file chứa private key
gdrive mcp                                    # chạy MCP server (stdio)
```

Với bản plugin Claude, thay `gdrive` bằng `node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs"`.

Khi đã có danh sách folder, `write` và `put` vào folder chỉ có quyền `read` bị từ chối ngay, và
`ls` không tham số in các folder được phép. Chưa có danh sách thì CLI dùng mọi thứ service
account thấy, còn khoá `mode` cũ quyết định có cho ghi hay không. Với ADC hoặc gcloud, token
mang nguyên quyền của tài khoản đó, nên giới hạn duy nhất là lớp kiểm folder và việc ẩn tool
ghi.

## Credential

Thứ tự tìm, dừng ở nguồn đầu tiên có:

1. Tham số `createClient({credentials})`
2. `GOOGLE_SERVICE_ACCOUNT_JSON` (JSON thô hoặc base64), tiện nhất cho CI
3. `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`
4. `DRIVE_SERVICE_ACCOUNT_EMAIL` + `DRIVE_PRIVATE_KEY`
5. `GOOGLE_APPLICATION_CREDENTIALS` (đường dẫn file key)
6. File config do `gdrive init` ghi (chmod 600), dò lần lượt `$GDRIVE_CONFIG_DIR`, thư mục data
   của plugin Claude (`~/.claude/plugins/data/gdrive*`), thư mục chung (`~/.config/gdrive-cli`,
   trên Windows là `%APPDATA%\gdrive-cli`), rồi `~/.claude/gdrive.json` của bản cài cũ
7. ADC của gcloud, chỉ khi đã chạy `gdrive init --adc`
8. `gcloud auth print-access-token`, cũng chỉ sau `gdrive init --adc`

Biến môi trường đứng trước file config vì CI thường có secret trong env và không có file config.
ADC và gcloud tắt mặc định vì chúng chạy bằng tài khoản cá nhân của bạn, với mọi quyền tài khoản
đó có. File config được ghi nguyên tử (ghi file tạm rồi đổi tên) với mode 600 ngay từ đầu.

## Dùng như thư viện

```js
import { createClient, readSheet, parseGoogleUrl } from 'gdrive-cli';

const client = createClient({ mode: 'readonly' });
const { id, gid } = parseGoogleUrl('https://docs.google.com/spreadsheets/d/…/edit#gid=123');
const { rows, sheet, sheets } = await readSheet(client, id, { gid });
console.log(client.identity.clientEmail);
```

Thư viện không đọc danh sách folder: script thấy mọi thứ service account thấy. `createClient`
nhận thêm `retries` (mặc định 0), `concurrency` (mặc định 4) và `timeoutMs` (mặc định 30000).

Để chuyển code đang dùng `googleapis` mà không sửa chỗ gọi, có sẵn một facade cùng hình dạng:

```js
import { createSheetsCompatClient } from 'gdrive-cli/sheets-compat';

const sheets = createSheetsCompatClient({ mode: 'readwrite' });
await sheets.spreadsheets.values.get({ spreadsheetId, range: "'Tab'!A1:C3" }); // → {data}
```

## Test

```bash
node --test
npm run bench
```

Bộ test có 310 test, chạy không cần mạng và không cần credential. Chữ ký JWT được kiểm bằng cặp
khoá sinh ngay lúc chạy, fixture ZIP/OOXML dựng trong bộ nhớ, còn `init`, `install`, `folder` và
`uninstall` chạy trên HOME tạm. MCP server được chạy như tiến trình con thật để bắt cả trường
hợp stdout lẫn thứ không phải JSON-RPC. CI chạy trên Linux, macOS và Windows với Node 18 và 22.

Bộ đọc `.xlsx` từng được đối chiếu với `python3` + `openpyxl` trên 6 file thật tải từ Drive:
3859 ô, không lệch ô nào.

## Đóng góp

Bản phát hành nằm trên `main`, phát triển diễn ra trên `develop`. PR nhắm vào `develop`. Cách
chạy dự án, quy ước và các nguyên tắc phải giữ nằm trong [CONTRIBUTING.md](CONTRIBUTING.md).
Lịch sử thay đổi ở [CHANGELOG.md](CHANGELOG.md).

Lỗ hổng bảo mật thì báo riêng theo [SECURITY.md](SECURITY.md), đừng mở issue công khai.

## Giấy phép

MIT
