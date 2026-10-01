# gdrive-cli

gdrive-cli cho trợ lý AI đọc và ghi Google Sheets, Docs, Slides và file trên Drive bằng một
service account riêng. Nó là một MCP server chạy trên máy bạn, dùng được với Claude Code,
Codex, GitHub Copilot (VS Code và CLI), Cursor, Kiro và các client MCP khác. Kèm theo là một CLI
và một thư viện Node cho script. Gói không có dependency nào, chỉ cần Node.js 18.17 trở lên.

## Nên dùng khi nào

Ưu điểm:

- AI chỉ thấy những file bạn share cho email của service account. Drive cá nhân và các file
  khác của bạn nằm ngoài tầm với của nó.
- Mặc định là readonly. Hai tool ghi (`gdrive_sheet_write`, `gdrive_upload`) bị ẩn khỏi danh
  sách tool, nên model không gọi được chúng cho tới khi bạn bật `readwrite`.
- Một lần cấu hình dùng cho mọi client. Máy có cả plugin Claude lẫn Cursor hay Codex thì tất cả
  đọc chung một file credential.
- Đọc được `.xlsx`, `.docx`, `.pptx` nằm trên Drive mà không cần Python hay LibreOffice.
  Google Slides được export sang `.pptx` rồi đọc từng slide, nên ranh giới giữa các slide còn
  nguyên.
- `gdrive_sheet_read` luôn trả về danh sách mọi tab kèm gid. Đọc nhầm tab thì gọi lại ngay với
  đúng tên tab.
- Chạy được trong CI và script qua biến môi trường (`GOOGLE_SERVICE_ACCOUNT_JSON`), không cần ai
  đăng nhập.
- Không có dependency: `googleapis` nặng 207 MB khi giải nén, còn gói này không cài thêm gì.

Nhược điểm:

- Phải tạo GCP project, bật Drive API và Sheets API, rồi tạo service account và tải file key.
  Lần đầu mất khoảng 5 phút.
- Mỗi file hoặc thư mục phải được share cho email của service account thì mới đọc được. Nếu tổ
  chức của bạn dùng Google Workspace và chặn share ra ngoài domain, hoặc cấm tạo key cho service
  account, bạn sẽ cần quản trị viên mở quyền.
- Service account không có dung lượng My Drive, nên upload chỉ chạy vào Shared Drive.
- Khả năng ghi chỉ gồm điền ô trong Sheets và upload file. Không sửa được nội dung Docs, không
  quản lý quyền share, không xoá file.
- PDF chỉ tải về, không trích chữ. File Office đời cũ (`.doc`, `.xls`, `.ppt`) bị từ chối.
- File key của service account là một secret dài hạn nằm trên đĩa (chmod 600). Lộ file đó thì
  phải thu hồi key trong GCP Console.
- Chưa có trên npm (tên `gdrive-cli` ở đó là gói của người khác), phải cài từ GitHub.

### So với connector Google Drive của Claude

Connector Google Drive có sẵn trong Claude đăng nhập bằng tài khoản Google của bạn qua OAuth và
thấy mọi file tài khoản đó thấy. Theo danh sách tool hiện có, nó tìm kiếm trên toàn Drive, đọc
nội dung, xem metadata và quyền, đồng thời tạo, sửa, copy, share và chuyển file vào thùng rác.
Connector chỉ chạy trong các sản phẩm của Claude.

| | gdrive-cli | Connector Google Drive của Claude |
|---|---|---|
| Danh tính | Service account riêng | Tài khoản Google của bạn (OAuth) |
| AI thấy gì | Chỉ file đã share cho service account | Mọi thứ tài khoản bạn thấy |
| Cài đặt | GCP project, file key, share từng file | Bấm kết nối, đăng nhập |
| Client | Claude Code, Codex, Copilot, Cursor, Kiro, client MCP bất kỳ | Claude |
| Script và CI | Có (CLI, thư viện, biến môi trường) | Không |
| Ghi | Ô trong Sheets, upload vào Shared Drive | Tạo, sửa, copy, share, xoá file |
| Chặn ghi mặc định | Tool ghi bị ẩn tới khi bật `readwrite` | Theo cấu hình connector |
| Chạy ở đâu | Trên máy bạn, gọi thẳng Google API | Qua hạ tầng của Claude |

Chọn gdrive-cli khi bạn muốn giới hạn chính xác những gì AI đọc được, khi dùng client không
phải Claude, hoặc khi cần chạy trong script và CI. Chọn connector khi bạn chỉ chat trong Claude,
muốn AI tìm được mọi file của mình, cần sửa hay share file, hoặc không muốn đụng tới GCP.

## Cài cho Claude Code

```
/plugin marketplace add sdc-ren/gdrive-cli
/plugin install gdrive@gdrive-cli
```

Sau đó chạy skill `/gdrive-setup` và đưa đường dẫn tới file JSON key của service account. CLI tự
đọc file, nên private key không đi qua cuộc hội thoại.

Plugin lưu cấu hình trong thư mục data của nó (`~/.claude/plugins/data/…`, chmod 600) và thư mục
này bị xoá khi gỡ plugin. Plugin không sửa `settings.json`.

## Cài cho Codex, Copilot, Cursor, Kiro

```bash
npm i -g github:sdc-ren/gdrive-cli
gdrive init --sa-json ~/keys/service-account.json
gdrive install --client cursor          # hoặc codex, copilot, copilot-cli, kiro — nhiều client: cursor,codex
```

Khởi động lại client để nạp các tool `gdrive_*`. Nếu máy đã có plugin Claude, `init` ghi đè file
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

## Các tool MCP

| Tool | Việc |
|---|---|
| `gdrive_sheet_read` | Google Sheets và `.xlsx` trên Drive, luôn trả kèm danh sách tab |
| `gdrive_read_document` | Docs, Slides, `.docx`, `.pptx`, `.csv`, `.txt` |
| `gdrive_file_info` | Cho biết file là gì và nên đọc bằng tool nào |
| `gdrive_list` · `gdrive_download` | Tìm và tải file |
| `gdrive_sheet_write` · `gdrive_upload` | Chỉ hiện ở chế độ `readwrite` |

Mọi tool nhận nguyên link dán vào và tự tách file id, gid. Bật ghi bằng
`gdrive init --mode readwrite` (bản plugin Claude:
`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" init --mode readwrite`). Server báo cho client danh
sách tool đã đổi; client không hỗ trợ thông báo này thì cần mở session mới.

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

Ở chế độ readonly, `write` và `put` bị từ chối ngay. Với service account, token chỉ được cấp
scope `.readonly`. Với ADC hoặc gcloud, token mang nguyên quyền của tài khoản đó, và giới hạn
duy nhất là các tool ghi bị ẩn.

## Đọc được những gì

| Định dạng | Đọc | Cách |
|---|---|---|
| Google Sheets | Có | Sheets API. Export CSV chỉ lấy được tab đầu nên không dùng |
| Google Docs | Có | `files.export` sang `text/markdown` |
| Google Slides | Có | Export `.pptx` rồi tự đọc. Export `text/plain` làm mất ranh giới slide |
| `.xlsx` / `.xlsm` | Có | ZIP + XML |
| `.docx` | Có | ZIP + XML, bảng chuyển thành markdown |
| `.pptx` | Có | ZIP + XML, giữ từng slide |
| `.csv` `.txt` `.md` `.json` | Có | Tải thẳng |
| PDF | Chỉ tải về | Để công cụ đọc PDF khác xử lý |
| `.doc` `.xls` `.ppt` | Không | Mở trong Drive, chọn File > Save as Google Docs/Sheets/Slides |

Các định dạng Office đời cũ là file nhị phân OLE2. Một parser đúng cho chúng dài hàng nghìn
dòng, còn parser làm dở thường trả ra chữ trông hợp lý nhưng sai. Gói chọn báo lỗi rõ ràng.

Auth là JWT RS256 tự ký bằng `node:crypto` (khoảng 170 dòng). Bộ đọc OOXML dùng
`zlib.inflateRawSync` có sẵn trong Node (khoảng 600 dòng).

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
ADC và gcloud tắt mặc định vì chúng chạy bằng tài khoản cá nhân của bạn chứ không phải service
account.

Service account có email riêng và không thấy file nào cho tới khi bạn share cho email đó (Viewer
để đọc, Editor để ghi). Nó cũng không có dung lượng My Drive: mọi lệnh ghi file vào My Drive
đều lỗi `403 storageQuotaExceeded`, kể cả khi đã share quyền Editor.

## Dùng như thư viện

```js
import { createClient, readSheet, parseGoogleUrl } from 'gdrive-cli';

const client = createClient({ mode: 'readonly' });
const { id, gid } = parseGoogleUrl('https://docs.google.com/spreadsheets/d/…/edit#gid=123');
const { rows, sheet, sheets } = await readSheet(client, id, { gid });
```

Để chuyển code đang dùng `googleapis` mà không sửa chỗ gọi, có sẵn một facade cùng hình dạng:

```js
import { createSheetsCompatClient } from 'gdrive-cli/sheets-compat';

const sheets = createSheetsCompatClient({ mode: 'readwrite' });
await sheets.spreadsheets.values.get({ spreadsheetId, range: "'Tab'!A1:C3" }); // → {data}
```

## Test

```bash
node --test
```

Bộ test có 211 test, chạy không cần mạng và không cần credential. Chữ ký JWT được kiểm bằng cặp
khoá sinh ngay lúc chạy, fixture ZIP/OOXML dựng trong bộ nhớ, còn `init`, `install` và
`uninstall` chạy trên HOME tạm. MCP server được chạy như tiến trình con thật để bắt cả trường
hợp stdout lẫn thứ không phải JSON-RPC. CI chạy trên Linux, macOS và Windows với Node 18 và 22.

Bộ đọc `.xlsx` từng được đối chiếu với `python3` + `openpyxl` trên 6 file thật tải từ Drive:
3859 ô, không lệch ô nào.

## Giấy phép

MIT
