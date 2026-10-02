# gdrive-cli

[![CI](https://github.com/sdc-ren/gdrive-cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sdc-ren/gdrive-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 18.17](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)
![Zero dependency](https://img.shields.io/badge/dependencies-0-lightgrey)

MCP server, CLI và thư viện Node để trợ lý AI đọc và ghi Google Sheets, Docs, Slides và file
Office trên Google Drive bằng một service account riêng. AI chỉ thấy những gì bạn share cho
service account, với đúng quyền bạn cấp.

Dùng được với Claude Code, Claude Desktop, Codex, GitHub Copilot (VS Code và CLI), Cursor, Kiro và mọi client MCP
chạy qua stdio.

## Mục lục

- [Tính năng](#tính-năng)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [Cài đặt](#cài-đặt)
- [Thiết lập service account](#thiết-lập-service-account)
- [Quyền](#quyền)
- [Tool MCP](#tool-mcp)
- [Định dạng hỗ trợ](#định-dạng-hỗ-trợ)
- [CLI](#cli)
- [Cấu hình](#cấu-hình)
- [Dùng như thư viện](#dùng-như-thư-viện)
- [Hiệu năng và độ ổn định](#hiệu-năng-và-độ-ổn-định)
- [Giới hạn](#giới-hạn)
- [So sánh với connector Google Drive của Claude](#so-sánh-với-connector-google-drive-của-claude)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Nâng cấp](#nâng-cấp)
- [Đóng góp](#đóng-góp)

## Tính năng

- Dán link file hoặc folder cho AI là dùng được.
- Quyền đi theo share trên Drive: Editor thì đọc và ghi, Viewer thì chỉ đọc, file chưa share thì
  AI không thấy. Khoá `readonly` chặn ghi ở mọi nơi.
- 5 tool với schema khoảng 560 token (connector Google Drive của Claude khoảng 3.600). Kết quả
  trả về là TSV hoặc markdown.
- Sheet lớn đọc được theo phần: lọc cột bằng `columns`, lọc giá trị bằng `where`, phân trang bằng
  `offset`/`limit`.
- Đọc trực tiếp `.xlsx`, `.docx`, `.pptx` mà không phải chuyển sang định dạng Google.
- Ghi ô, thêm dòng, tạo folder/Doc/Sheet, đổi tên và di chuyển file. Gói không có thao tác xoá file
  hay đổi quyền share.
- Mỗi request có timeout và được thử lại theo `Retry-After`. Request ghi chưa rõ kết quả thì không
  gửi lại. Metadata được cache 5 phút.
- Không có dependency, chỉ dùng API sẵn có của Node.js 18.17 trở lên. Auth là JWT tự ký bằng
  `node:crypto`.

## Bắt đầu nhanh

```bash
npm install -g github:sdc-ren/gdrive-cli
gdrive init --sa-json ~/keys/service-account.json   # in ra email của service account
gdrive install --client claude                      # hoặc claude-desktop, codex, copilot, cursor, kiro
```

1. Share file hoặc folder cần dùng cho email mà `gdrive init` in ra.
2. Khởi động lại client AI.
3. Gửi link cho AI, ví dụ: *"Đọc các test case FAIL trong https://docs.google.com/spreadsheets/d/…"*

Chưa có file key? Xem [Thiết lập service account](#thiết-lập-service-account).

## Cài đặt

Cần Node.js 18.17 trở lên. Cách cài chung cho mọi client gồm ba bước: cài CLI, nạp key, đăng ký
với client. Riêng Claude Code còn có thể [cài dạng plugin](#claude-code-dạng-plugin).

### 1. Cài CLI toàn cục

```bash
npm install -g github:sdc-ren/gdrive-cli
gdrive --version
```

Cài một phiên bản cố định theo tag trong trang [Releases](https://github.com/sdc-ren/gdrive-cli/releases):

```bash
npm install -g github:sdc-ren/gdrive-cli#v0.5.1
```

Gói cài từ GitHub vì tên `gdrive-cli` trên npm thuộc một dự án khác. Cập nhật bằng cách chạy lại
lệnh cài.

### 2. Nạp key của service account

```bash
gdrive init --sa-json ~/keys/service-account.json
```

Lệnh kiểm tra key, ghi cấu hình (chmod 600) và in email service account. Chưa có key thì xem
[Thiết lập service account](#thiết-lập-service-account).

### 3. Đăng ký với client AI

```bash
gdrive install --client claude              # một client
gdrive install --client claude,cursor       # nhiều client
gdrive install --client claude --project    # ghi vào repo đang đứng
gdrive install --client claude --skill      # cài thêm skill hướng dẫn dùng tool
```

| `--client` | Cấp user (mặc định) | `--project` |
|---|---|---|
| `claude` (Claude Code) | Chạy `claude mcp add --scope user` | `.mcp.json` |
| `claude-desktop` | `claude_desktop_config.json` trong thư mục dữ liệu của Claude Desktop | không hỗ trợ |
| `codex` | `~/.codex/config.toml` | `.codex/config.toml` (Codex chỉ đọc khi project đã trust) |
| `copilot` (VS Code) | `mcp.json` trong thư mục User của VS Code | `.vscode/mcp.json` |
| `copilot-cli` | `~/.copilot/mcp-config.json` | không hỗ trợ |
| `cursor` | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| `kiro` | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` |

Thư mục dữ liệu của Claude Desktop là `~/Library/Application Support/Claude` trên macOS và
`%APPDATA%\Claude` trên Windows. Khởi động lại client sau khi đăng ký để nạp các tool `drive_*`.

Cách `install` sửa cấu hình của client:
- Chỉ thêm hoặc thay khoá `gdrive`; các server khác giữ nguyên. Chạy lại nhiều lần cho ra cùng
  một kết quả.
- Không ghi credential vào cấu hình của client.
- Với Claude Code ở cấp user, `install` gọi lệnh `claude mcp add` thay vì sửa `~/.claude.json`.
  Máy không có lệnh `claude` thì `install` in ra lệnh để bạn tự chạy.
- Ở cấp user, cấu hình chứa đường dẫn tuyệt đối tới `node` và server, vì app mở từ Dock hay Start
  menu thường không có PATH của nvm hoặc Homebrew. Đổi phiên bản Node thì chạy lại `install`.
- `--project` ghi lệnh `gdrive mcp`, không chứa đường dẫn trên máy, nên file commit được. Ai dùng
  repo cũng cần cài CLI toàn cục.
- `--skill` chép skill vào `~/.claude/skills` (Claude Code), `~/.kiro/skills` (Kiro) hoặc
  `~/.agents/skills` (Codex, Copilot, Cursor). Claude Desktop không dùng skill.
- File có comment (JSONC) hoặc TOML khó sửa an toàn thì `install` để nguyên và in đoạn cấu hình
  để bạn tự dán.

### Claude Code dạng plugin

Cách thay thế cho ba bước trên, không cần npm:

```
/plugin marketplace add sdc-ren/gdrive-cli
/plugin install gdrive@gdrive-cli
```

Sau đó chạy `/gdrive-setup`. Skill hỏi đường dẫn file key, ghi cấu hình rồi in email service
account. Private key được đọc từ file, không đi qua hội thoại. Nếu máy có cả CLI toàn cục thì hai
bên dùng chung một file cấu hình. Dùng plugin thì không cần `gdrive install --client claude`.

### Client MCP khác

Trỏ client vào lệnh `gdrive mcp` (MCP qua stdio). Ví dụ với định dạng `mcpServers` phổ biến:

```json
{
  "mcpServers": {
    "gdrive": { "command": "gdrive", "args": ["mcp"] }
  }
}
```

### Gỡ cài đặt

```bash
gdrive uninstall --client claude     # gỡ đăng ký khỏi từng client (thêm --project nếu cần)
gdrive uninstall --purge             # xoá file cấu hình chứa private key
npm uninstall -g gdrive-cli
```

Với plugin Claude Code: `/plugin uninstall gdrive@gdrive-cli`. Thư mục cấu hình của plugin bị xoá
theo.

Xoá file cấu hình không thu hồi được key. Nếu key có thể đã lộ, xoá key đó trong GCP Console (xem
[SECURITY.md](SECURITY.md)).

## Thiết lập service account

Làm một lần, mất khoảng 5 phút:

1. Vào [Google Cloud Console](https://console.cloud.google.com/), tạo project hoặc chọn project có
   sẵn.
2. Bật cả hai API:
   [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) và
   [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com).
3. Vào IAM & Admin → Service Accounts → Create service account. Không cần cấp role.
4. Mở service account vừa tạo, chọn Keys → Add key → Create new key → JSON. File key tự tải
   về.
5. Chạy `gdrive init --sa-json <đường-dẫn-file-key>`. Lệnh kiểm tra key, ghi cấu hình (chmod 600)
   và in email service account.
6. Share file hoặc folder cho email đó, giống share cho một đồng nghiệp.

Service account là một danh tính riêng, có email dạng `…@….iam.gserviceaccount.com`. Nó không thấy
gì trong Drive của bạn cho tới khi được share.

`gdrive status` kiểm tra từng bước: Node, cấu hình, quyền file, token, API đã bật hay chưa, client
nào đã đăng ký.

## Quyền

| Share cho email service account | AI làm được |
|---|---|
| Editor | Đọc, ghi ô, thêm dòng, tạo, đổi tên, di chuyển |
| Viewer hoặc Commenter | Chỉ đọc |
| Không share | Không thấy; tool báo lỗi kèm email cần share |

Khoá `mode` trong cấu hình áp lên tất cả:

| `mode` | Hành vi |
|---|---|
| `readwrite` (mặc định của `gdrive init`) | Ghi được ở nơi service account là Editor |
| `readonly` | Chỉ đọc ở mọi nơi. Ba tool ghi bị ẩn, token chỉ xin scope `*.readonly` |

Đổi chế độ mà giữ nguyên key:

```bash
gdrive init --mode readonly --yes
gdrive init --mode readwrite --yes
```

Trước khi gọi API ghi, tool kiểm tra quyền Editor từ metadata Drive trả về lúc mở link. Thiếu quyền
thì tool báo `Chỉ đọc` thay vì để Drive trả 403 thô. Bước kiểm tra này không tốn thêm request, và
Drive vẫn là nơi chặn cuối cùng. Shortcut được mở tới file đích, và quyền cũng tính theo file đích.

> [!IMPORTANT]
> AI ghi được mọi thứ mà service account là Editor. Thứ gì chỉ cần đọc thì share quyền Viewer.
> Hãy coi email service account là tài khoản riêng của AI: thứ gì share cho nó, AI mở được khi có
> link.

## Tool MCP

| Tool | Việc | Cần quyền |
|---|---|---|
| `drive_ls` | Liệt kê nội dung một folder, lọc theo tên | Viewer |
| `drive_read` | Đọc file: Sheet và xlsx ra TSV; Doc, Slides, docx, pptx, txt ra markdown | Viewer |
| `sheet_write` | Ghi ô (`{"L5": "PASS"}`) và/hoặc thêm dòng vào Google Sheet | Editor |
| `drive_create` | Tạo folder, Google Doc từ markdown, Google Sheet từ CSV/TSV | Editor với folder cha |
| `drive_move` | Đổi tên, chuyển file sang folder khác | Editor với file và folder đích |

Mọi tham số `target`, `path`, `parent`, `to` nhận link Google dán nguyên hoặc id.

Kết quả là văn bản thuần. Dòng đầu bắt đầu bằng `#` mô tả ngữ cảnh. Lỗi bắt đầu bằng `✗`. Ví dụ
`drive_read` với `{"target": "<link sheet>", "columns": ["ID", "Ghi chú"], "where": {"Trạng thái": "FAIL"}}`:

```
# TC_login › Sheet1 · tabs: Sheet1,Data · rows 1-2/2
ID	Ghi chú
TC-07	Sai thông báo khi mật khẩu rỗng
TC-12	Timeout ở bước xác thực OTP
```

Dòng đầu liệt kê mọi tab. Còn dòng chưa đọc thì dòng đầu có `next=<offset>` để model đọc tiếp.
Mỗi trang mặc định 200 dòng, tối đa 2.000.

`sheet_write` và `drive_create` từ chối công thức `IMPORTRANGE`, `IMPORTDATA`, `IMPORTXML`,
`IMPORTHTML`, `IMPORTFEED` và `IMAGE`, vì chúng có thể kéo dữ liệu từ file khác vào hoặc gửi dữ
liệu ra ngoài. Cần dùng thì gõ trực tiếp trong Google Sheets.

## Định dạng hỗ trợ

| Định dạng | Đọc | Cách đọc |
|---|---|---|
| Google Sheets | Có | Sheets API, đọc được mọi tab |
| Google Docs | Có | Export sang markdown |
| Google Slides | Có | Export `.pptx` rồi đọc từng slide |
| `.xlsx`, `.xlsm` | Có | ZIP + XML |
| `.docx` | Có | ZIP + XML, bảng chuyển thành markdown |
| `.pptx` | Có | ZIP + XML, giữ thứ tự slide và ghi chú |
| `.csv`, `.txt`, `.md`, `.json` | Có | Tải thẳng |
| PDF | Không trích chữ | `drive_read` trả metadata; tải bằng `gdrive get` |
| `.doc`, `.xls`, `.ppt` | Không | Mở trong Drive, chọn File → Save as Google Docs/Sheets/Slides |

File trên 50 MB và file ZIP giải nén ra hơn 256 MB bị từ chối.

## CLI

```bash
gdrive read   <url> [--sheet <tên|gid>] [--range A1:E50] [--json]
gdrive doc    <url> [--format markdown|text] [--notes]
gdrive info   <url>
gdrive ls     [<url-folder>] [--name-contains <chuỗi>] [--query <q>] [--max <n>]
gdrive get    <url> --out <path>
gdrive put    <file> --folder <url> [--name <tên>] [--share none|anyone-reader]
gdrive write  <url> --set L5=PASSED --set L6=FAILED
gdrive init   [--sa-json <file> | --adc] [--mode readonly|readwrite] [--yes]
gdrive status
gdrive install   --client <tên> [--project] [--skill]
gdrive uninstall --client <tên> [--project]
gdrive uninstall [--purge]
gdrive mcp
```

- Các lệnh nhận link hoặc id. Quyền trên từng file do Drive quyết định.
- `write` và `put` cần `mode: readwrite`, hoặc thêm `--mode readwrite` cho một lần chạy.
- `ls` không kèm link sẽ liệt kê mọi thứ service account thấy.
- `--json` in dữ liệu cho máy đọc.
- Trong plugin Claude Code, thay `gdrive` bằng `node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs"`.

## Cấu hình

### Nguồn credential

Thứ tự tìm, dừng ở nguồn đầu tiên có:

1. Tham số `createClient({ credentials })` (khi dùng như thư viện)
2. `GOOGLE_SERVICE_ACCOUNT_JSON`: JSON thô hoặc base64, tiện cho CI
3. `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`
4. `DRIVE_SERVICE_ACCOUNT_EMAIL` + `DRIVE_PRIVATE_KEY`
5. `GOOGLE_APPLICATION_CREDENTIALS`: đường dẫn file key
6. File cấu hình do `gdrive init` ghi
7. ADC của gcloud, chỉ khi đã chạy `gdrive init --adc`
8. `gcloud auth print-access-token`, cũng chỉ sau `gdrive init --adc`

ADC và gcloud tắt mặc định vì chúng chạy bằng tài khoản Google cá nhân, với mọi quyền của tài
khoản đó.

### File cấu hình

`gdrive init` ghi file `config.json` với chmod 600, ghi nguyên tử. Thứ tự tìm:

1. `$GDRIVE_CONFIG_DIR`
2. Thư mục data của plugin Claude Code (`~/.claude/plugins/data/gdrive*`)
3. `~/.config/gdrive-cli` (Linux, macOS) hoặc `%APPDATA%\gdrive-cli` (Windows)
4. `~/.claude/gdrive.json` của bản cài cũ

Mỗi máy chỉ nên có một file chứa private key. `gdrive status` cảnh báo khi tìm thấy nhiều file.

### Biến môi trường

| Biến | Tác dụng |
|---|---|
| `GDRIVE_CONFIG_DIR` | Thư mục cấu hình, ưu tiên hơn mọi vị trí khác |
| `GDRIVE_DEBUG=1` | In từng request (method, đường dẫn, kết quả, thời gian, lần thử) ra stderr |

Khi không có file cấu hình (ví dụ CI chỉ dùng biến môi trường), MCP server chạy ở chế độ
`readonly`. CLI thì thêm `--mode readwrite` cho lệnh cần ghi.

## Dùng như thư viện

```bash
npm install github:sdc-ren/gdrive-cli
```

```js
import { createClient, readSheet, parseGoogleUrl } from 'gdrive-cli';

const client = createClient({ mode: 'readonly' });
const { id, gid } = parseGoogleUrl('https://docs.google.com/spreadsheets/d/…/edit#gid=123');
const { rows, sheet, sheets } = await readSheet(client, id, { gid });
console.log(client.identity.clientEmail);
```

`createClient` nhận thêm `retries` (mặc định 0), `concurrency` (mặc định 4) và `timeoutMs` (mặc định
30.000). Thư viện không đọc khoá `mode` trong file cấu hình; quyền ghi phụ thuộc tham số `mode` và
quyền share trên Drive.

Để chuyển code đang dùng `googleapis` mà không sửa chỗ gọi, dùng facade cùng hình dạng:

```js
import { createSheetsCompatClient } from 'gdrive-cli/sheets-compat';

const sheets = createSheetsCompatClient({ mode: 'readwrite' });
await sheets.spreadsheets.values.get({ spreadsheetId, range: "'Tab'!A1:C3" }); // → { data }
```

## Hiệu năng và độ ổn định

| | Token (tiktoken `o200k_base`) |
|---|---|
| Schema tool, có quyền ghi | 557 (connector Google Drive của Claude: 3.610) |
| Schema tool, chỉ đọc | 265 + 195 instructions (connector: 2.337) |
| Đọc 10 dòng đầu của một sheet | 2.599 |

- Mở một link tốn 1 request metadata (cache 5 phút) cộng 1 request nội dung. Đọc lại cùng sheet
  mất khoảng 360 đến 390 ms.
- Mỗi request có timeout 30 giây.
- Lỗi tạm thời (429, 5xx, 403 `rateLimitExceeded`) được thử lại theo `Retry-After`, có jitter. MCP
  server thử tối đa 4 lần, CLI 2 lần.
- Request không idempotent (thêm dòng, tạo file) không gửi lại khi mất câu trả lời giữa chừng.
  Tool báo `Chưa chắc đã ghi` để model đọc lại trước khi thử, tránh ghi trùng.
- Token bị thu hồi (401) thì lấy token mới và thử lại đúng một lần.
- Tối đa 4 request tới Google chạy cùng lúc.

Số đo đầy đủ và cách đo: [docs/benchmarks.md](docs/benchmarks.md).

## Giới hạn

- Service account không có dung lượng My Drive. Doc và Sheet mới chỉ tạo được trong folder trên
  Shared Drive. Folder thì tạo ở đâu cũng được. Với My Drive, hãy tự tạo Sheet rồi để AI ghi vào
  bằng `sheet_write`.
- Không sửa nội dung Google Docs, không quản lý quyền share, không xoá file, không trích chữ từ
  PDF.
- Lần đầu phải tạo GCP project và service account.
- Tổ chức dùng Google Workspace có thể chặn share ra ngoài domain hoặc cấm tạo key cho service
  account. Khi đó cần quản trị viên mở quyền.
- File key là secret dài hạn nằm trên đĩa. Nếu lộ, thu hồi key trong GCP Console.

## So sánh với connector Google Drive của Claude

| | gdrive-cli | Connector Google Drive của Claude |
|---|---|---|
| Danh tính | Service account riêng | Tài khoản Google của bạn (OAuth) |
| AI thấy gì | Chỉ những gì đã share cho service account | Mọi thứ tài khoản bạn thấy |
| Cài đặt | GCP project, file key, share | Bấm kết nối, đăng nhập |
| Client | Claude Code, Claude Desktop, Codex, Copilot, Cursor, Kiro, client MCP bất kỳ | Các sản phẩm của Claude |
| Script và CI | Có (CLI, thư viện, biến môi trường) | Không |
| Ghi | Ô và dòng trong Sheets, tạo folder/Doc/Sheet, đổi tên, di chuyển | Tạo, sửa, copy, share, xoá file |
| Schema tool | 557 token | 3.610 token |
| Chạy ở đâu | Trên máy bạn, gọi thẳng Google API | Qua hạ tầng của Claude |

gdrive-cli hợp khi bạn muốn giới hạn chính xác những gì AI đọc và ghi, dùng client khác Claude,
hoặc chạy trong script và CI. Connector hợp khi bạn chỉ chat trong Claude, muốn AI tìm trên toàn
Drive, cần share hay xoá file, hoặc không muốn đụng tới GCP.

## Xử lý sự cố

| Thông báo | Nguyên nhân và cách xử lý |
|---|---|
| `✗ 404: chưa share cho …` hoặc `✗ 403: …` | File chưa được share cho email service account. Share quyền Viewer để đọc, Editor để ghi |
| `✗ Chỉ đọc: service account chưa có quyền Editor …` | Đổi quyền share thành Editor rồi thử lại |
| `Đang ở chế độ readonly …` | Chạy `gdrive init --mode readwrite --yes` |
| `storageQuotaExceeded` | Service account không có dung lượng My Drive. Tạo file trong Shared Drive |
| `SERVICE_DISABLED` hoặc `has not been used` | Bật Google Drive API và Google Sheets API cho project |
| `401` khi lấy token | Key đã bị xoá trong GCP, hoặc đồng hồ máy lệch hơn 5 phút |
| Client không thấy tool `drive_*` | Khởi động lại client. Chạy `gdrive status` để kiểm đường dẫn `node` trong cấu hình client |

`gdrive status` kiểm tra lần lượt từng bước và chỉ ra bước nào hỏng. `GDRIVE_DEBUG=1` in chi tiết
từng request.

## Nâng cấp

Danh sách thay đổi đầy đủ ở [CHANGELOG.md](CHANGELOG.md).

### Từ v0.4

- Không còn danh sách folder. Khoá `folders` trong cấu hình và biến `GDRIVE_FOLDERS` bị bỏ qua;
  `gdrive init` chạy lại sẽ xoá khoá này. Lệnh `gdrive folder` đã bỏ.
- Cấu hình cũ thường có `mode: readonly` và được giữ nguyên. Muốn ghi thì chạy
  `gdrive init --mode readwrite --yes`.
- `drive_ls` cần link folder. Địa chỉ dạng `alias/đường/dẫn` không còn dùng được; prompt hay skill
  riêng nào dùng alias thì đổi sang link hoặc id.

### Từ v0.3

Tên tool đổi:

| v0.3 | Từ v0.4 |
|---|---|
| `gdrive_sheet_read`, `gdrive_read_document`, `gdrive_file_info` | `drive_read` |
| `gdrive_list` | `drive_ls` |
| `gdrive_sheet_write` | `sheet_write` |
| `gdrive_download`, `gdrive_upload` | bỏ khỏi MCP (CLI `get`, `put` vẫn còn) |

Kết quả tool là văn bản thuần thay cho JSON. `createClient()` không trả `credentials` nữa; dùng
`client.identity.clientEmail`.

## Đóng góp

Bản phát hành nằm trên nhánh `main`; phát triển diễn ra trên
`develop`, và PR nhắm vào `develop`.

```bash
git clone https://github.com/sdc-ren/gdrive-cli.git
cd gdrive-cli
git switch develop
node --test        # chạy không cần mạng hay credential
npm run bench
```

Quy ước, cấu trúc mã và các nguyên tắc phải giữ nằm trong [CONTRIBUTING.md](CONTRIBUTING.md). CI chạy
trên Linux, macOS và Windows với Node 18 và 22.

Lỗ hổng bảo mật xin báo riêng theo [SECURITY.md](SECURITY.md), đừng mở issue công khai.

## Giấy phép

[MIT](LICENSE)
