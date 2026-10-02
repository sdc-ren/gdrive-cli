# gdrive-cli

gdrive-cli cho trợ lý AI đọc và ghi Google Sheets, Docs, Slides và file Office trên Drive bằng
một service account riêng, với đúng quyền bạn share cho nó. Nó là một MCP server chạy
trên máy bạn, dùng được với Claude Code, Codex, GitHub Copilot (VS Code và CLI), Cursor, Kiro và
các client MCP khác, kèm một CLI và một thư viện Node cho script. Gói không có dependency nào,
chỉ cần Node.js 18.17 trở lên.

## Cách dùng

1. Cài plugin hoặc CLI (xem các mục cài đặt bên dưới).
2. Chạy `gdrive init --sa-json <file-key.json>`. Lệnh in ra email của service account.
3. Share file hoặc folder cần dùng cho email đó, giống như share cho một đồng nghiệp.
4. Gửi link cho AI. AI mở thẳng link đó, không phải khai báo folder trước.

## Quyền

Quyền đi theo cách bạn share trên Drive:

| Share cho email service account | AI làm được |
|---|---|
| Editor | đọc, ghi ô, append, tạo, đổi tên, di chuyển |
| Viewer / Commenter | chỉ đọc |
| Không share | báo lỗi kèm email cần share |
| `mode: readonly` trong config | chỉ đọc ở mọi nơi, tool ghi bị ẩn |

Tool ghi kiểm quyền Editor (`capabilities` trong metadata Drive trả về khi mở link) trước khi gọi
API ghi. Thiếu quyền thì tool báo `Chỉ đọc` thay vì để Drive trả 403. Việc kiểm này không tốn thêm
request, và Drive vẫn là nơi chặn cuối cùng. Shortcut được mở tới file đích, quyền cũng tính theo
file đích.

`gdrive init` mặc định `mode: readwrite`. Muốn chặn ghi hoàn toàn thì chạy
`gdrive init --mode readonly --yes`: token chỉ xin scope `.readonly` và ba tool ghi
(`sheet_write`, `drive_create`, `drive_move`) không xuất hiện.

Trước khi share, nhớ rằng AI ghi được mọi thứ mà service account là Editor. Thứ gì chỉ cần đọc
thì share quyền Viewer. Coi email service account như tài khoản riêng của AI: share nhầm thứ gì
cho nó thì AI cũng mở được khi có link.

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
- MCP server cache metadata Drive và Sheets 5 phút. Quyền đọc từ chính metadata này nên không
  tốn request riêng. Cache bị xoá khi chính server tạo, đổi tên hay di chuyển file.
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

Docx được export lại mỗi lần đọc vì nội dung file không được cache. Liệt kê ở v0.4 chậm hơn v0.3
vì có thêm một lần `files.get` để kiểm phạm vi folder. Từ v0.5, lần `files.get` đó lấy tên và
quyền của folder, còn việc lần theo folder cha thì đã bỏ. Connector của Claude không lộ thời gian
nên không có cột so sánh.

## Cài cho Claude Code

```
/plugin marketplace add sdc-ren/gdrive-cli
/plugin install gdrive@gdrive-cli
```

Sau đó chạy skill `/gdrive-setup`. Skill hỏi đường dẫn tới file JSON key của service account
rồi nhắc bạn share file hoặc folder cho email của nó. CLI tự đọc file key, nên private key không
đi qua cuộc hội thoại.

Plugin lưu cấu hình trong thư mục data của nó (`~/.claude/plugins/data/…`, chmod 600) và thư mục
này bị xoá khi gỡ plugin. Plugin không sửa `settings.json`.

## Cài cho Codex, Copilot, Cursor, Kiro

```bash
npm i -g github:sdc-ren/gdrive-cli
gdrive init --sa-json ~/keys/service-account.json
gdrive install --client cursor          # hoặc codex, copilot, copilot-cli, kiro; nhiều client: cursor,codex
```

Share file hoặc folder cho email service account mà `init` in ra, rồi khởi động lại client để nạp
các tool `drive_*`. Nếu máy đã có plugin Claude, `init` ghi đè file
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
| `drive_ls` | Nội dung một folder (`path` là link folder, bắt buộc), lọc theo tên bằng `query` |
| `drive_read` | Đọc mọi loại file được hỗ trợ: Sheet và xlsx ra TSV (lọc `columns`, `where`, phân trang `offset`/`limit`), Doc, Slides, docx, pptx, txt ra markdown |
| `sheet_write` | Ghi ô (`{"L5": "PASS"}`) và/hoặc thêm dòng vào Google Sheet |
| `drive_create` | Tạo folder, Google Doc từ markdown, Google Sheet từ CSV/TSV |
| `drive_move` | Đổi tên, chuyển file sang folder khác (cần Editor với file và folder đích) |

Mọi `target`, `path`, `parent`, `to` nhận link Google dán nguyên hoặc id. Đưa link file cho
`drive_ls` thì tool báo đó không phải folder và gợi ý `drive_read`. Kết quả là văn bản thuần. Dòng đầu bắt đầu bằng `#` mô tả ngữ cảnh, lỗi bắt
đầu bằng `✗`.

Ví dụ `drive_read` với `{"target": "https://docs.google.com/spreadsheets/d/1AbC…/edit", "columns": ["ID", "Ghi chú"], "where": {"Trạng thái": "FAIL"}}`:

```
# TC_login › Sheet1 · tabs: Sheet1,Data · rows 1-2/2
ID	Ghi chú
TC-07	Sai thông báo khi mật khẩu rỗng
TC-12	Timeout ở bước xác thực OTP
```

Dòng đầu luôn liệt kê mọi tab. Khi còn dòng chưa đọc, dòng đầu có thêm `next=<offset>`, và model
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
| AI thấy gì | Chỉ những gì đã share cho service account | Mọi thứ tài khoản bạn thấy |
| Cài đặt | GCP project, file key, share cho service account | Bấm kết nối, đăng nhập |
| Client | Claude Code, Codex, Copilot, Cursor, Kiro, client MCP bất kỳ | Claude |
| Script và CI | Có (CLI, thư viện, biến môi trường) | Không |
| Ghi | Ô và dòng trong Sheets, tạo folder/Doc/Sheet, đổi tên, chuyển file | Tạo, sửa, copy, share, xoá file |
| Schema tool (tiktoken) | 561 token khi có quyền ghi | 3.610 token |
| Chạy ở đâu | Trên máy bạn, gọi thẳng Google API | Qua hạ tầng của Claude |

Chọn gdrive-cli khi bạn muốn giới hạn chính xác những gì AI đọc và ghi được, khi dùng client khác
Claude, hoặc khi cần chạy trong script và CI. Chọn connector khi bạn chỉ chat trong Claude, muốn
AI tìm được mọi file của mình, cần share file, hoặc không muốn đụng tới GCP.

## Nâng cấp từ v0.4.0

- Khoá `folders` trong config và biến `GDRIVE_FOLDERS` không còn tác dụng. Xoá hay giữ đều được;
  `gdrive init` chạy lại sẽ xoá khoá này.
- Lệnh `gdrive folder` (`folder add`, `folder list`, `folder set`, `folder remove`) đã bỏ. Quyền
  lấy theo share trên Drive (xem mục [Quyền](#quyền)).
- Config tạo bằng `init` từ v0.2 tới v0.4 thường ghi `mode: readonly` và được giữ nguyên. Muốn
  ghi thì chạy `gdrive init --mode readwrite --yes` (giữ key cũ, chỉ đổi mode). `gdrive status`
  nhắc lệnh này khi đang readonly.
- `drive_ls` cần link folder. Gọi không tham số hay dùng địa chỉ dạng `alias/đường/dẫn` không còn
  chạy; prompt hay skill riêng nào dùng alias thì đổi sang link hoặc id.
- Chạy chỉ bằng biến môi trường (`GOOGLE_SERVICE_ACCOUNT_JSON`…) mà không có file config thì MCP
  server ở chế độ readonly. Trước đây `GDRIVE_FOLDERS=…:write` mở được quyền ghi; giờ cần một file
  config có `mode: readwrite` (`gdrive init`). Với CLI thì thêm `--mode readwrite` cho lần chạy.

## Nâng cấp từ v0.3

Đọc thêm mục v0.4.0 ở trên. Tên tool đổi như sau:

| v0.3 | v0.4 trở đi |
|---|---|
| `gdrive_sheet_read` | `drive_read` |
| `gdrive_read_document` | `drive_read` |
| `gdrive_file_info` | `drive_read` |
| `gdrive_list` | `drive_ls` |
| `gdrive_sheet_write` | `sheet_write` |
| `gdrive_download` | bỏ khỏi MCP (CLI `get` vẫn còn) |
| `gdrive_upload` | bỏ khỏi MCP (CLI `put` vẫn còn) |

Prompt, skill hay tài liệu riêng nào nhắc tên cũ thì cần sửa theo bảng trên.

Những thứ khác thay đổi:

- Ai đã chạy `gdrive install --client` không phải chạy lại. Entry MCP trong config của client
  vẫn trỏ vào cùng lệnh.
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
gdrive init  [--sa-json <file>|--adc] [--mode readonly|readwrite]
gdrive status
gdrive install   --client <tên> [--project] [--skill]
gdrive uninstall --client <tên> [--project]   # gỡ đăng ký khỏi client
gdrive uninstall [--purge]                    # dọn bản cài cũ; --purge xoá cả file chứa private key
gdrive mcp                                    # chạy MCP server (stdio)
```

Với bản plugin Claude, thay `gdrive` bằng `node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs"`.

Các lệnh nhận link hoặc id, và Drive quyết định quyền trên từng file. `write` và `put` cần
`mode: readwrite` (hoặc `--mode readwrite` cho một lần chạy). `ls` không tham số liệt kê những gì
service account thấy, để bạn tự xem; AI không dùng cách này. Với ADC hoặc gcloud, token mang
nguyên quyền của tài khoản đó, nên chỉ còn khoá `mode` chặn được việc ghi.

`write` từ chối giá trị là công thức `IMPORT*`/`IMAGE` (bắt đầu bằng `=` hoặc `+`), giống tool MCP; cần công thức đó thì gõ trực tiếp trong Google Sheets.

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

Thư viện không kiểm quyền phía client và không đọc khoá `mode` trong config: script làm được mọi
thứ service account được share, trong giới hạn scope của tham số `mode`. `createClient`
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

Bộ test có 304 test, chạy không cần mạng và không cần credential. Chữ ký JWT được kiểm bằng cặp
khoá sinh ngay lúc chạy, fixture ZIP/OOXML dựng trong bộ nhớ, còn `init`, `install` và `uninstall`
chạy trên HOME tạm. MCP server được chạy như tiến trình con thật để bắt cả trường
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
