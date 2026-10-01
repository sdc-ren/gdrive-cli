# Changelog

Mọi thay đổi người dùng thấy được đều ghi ở đây. Định dạng theo
[Keep a Changelog](https://keepachangelog.com/vi/1.1.0/), phiên bản theo
[Semantic Versioning](https://semver.org/lang/vi/).

## [Chưa phát hành]

## [0.4.0] - 2026-10-01

### Thay đổi phá tương thích

- Mọi truy cập giới hạn trong danh sách folder. Sau khi nâng cấp phải chạy
  `gdrive folder add <url> [--access write]`; danh sách rỗng thì mọi tool từ chối.
- Tool MCP đổi: `gdrive_sheet_read`, `gdrive_read_document`, `gdrive_file_info` gộp thành
  `drive_read`; `gdrive_list` thành `drive_ls`; `gdrive_sheet_write` thành `sheet_write`;
  `gdrive_download` và `gdrive_upload` bỏ khỏi MCP (CLI `get`/`put` vẫn còn).
- Kết quả tool là văn bản thuần (TSV, markdown), không còn JSON.
- Khoá `mode` trong config không còn tác dụng khi có `folders`; quyền đặt theo từng folder.
- `createClient()` không trả `credentials` nữa; dùng `client.identity`.

### Thêm

- `drive_create` (folder, Doc từ markdown, Sheet từ CSV/TSV) và `drive_move`.
- `drive_read` lọc `columns`, `where`, phân trang `offset`/`limit`.
- `sheet_write` thêm `append`.
- `gdrive folder add/list/set/remove`; biến `GDRIVE_FOLDERS` cho CI.
- Cache metadata Drive/Sheets 5 phút và tổ tiên folder 10 phút trong MCP server.
- Timeout 30 giây, thử lại theo `Retry-After` có jitter, giới hạn 4 request đồng thời, `GDRIVE_DEBUG=1`.
- `npm run bench` đo token; CI đỏ khi schema vượt 700 token ước lượng.
- `SECURITY.md`, `CONTRIBUTING.md`, template issue và PR.
- `sheet_write` và `drive_create` (sheet) từ chối công thức `IMPORT*`/`IMAGE`: chúng kéo dữ
  liệu ngoài phạm vi folder vào hoặc gửi dữ liệu ra ngoài.
- `gdrive status` liệt kê folder được phép, báo đỏ khi danh sách rỗng.
- `gdrive ls --query` bị từ chối khi đã có danh sách folder (mệnh đề `q` thô thoát được phạm vi).
- `gdrive get` không giới hạn thời gian tải; upload có timeout theo kích thước file.

### Đổi

- `main` là nhánh phát hành mặc định, `develop` là nhánh phát triển. PR nhắm vào `develop`.
- CI chạy khi push hoặc mở PR vào `main` và `develop`.
- URL repo trong `package.json` và manifest plugin trỏ về `sdc-ren/gdrive-cli`.

### Sửa

- Drive báo giới hạn tốc độ bằng 403 `rateLimitExceeded` giờ được thử lại; trước đó bị coi là lỗi vĩnh viễn.
- Request không idempotent (`append`, tạo file) không gửi lại khi mất trả lời, tránh ghi trùng.
- Thứ tự slide pptx lấy từ `presentation.xml` thay vì số trong tên file; notes ghép qua rels.
- docx ở dạng text không còn xoá hàng bảng có số âm ở cột đầu.
- xlsx đọc `r:id` với mọi tiền tố namespace.
- Chặn file trên 50 MB và zip giải nén trên 256 MB.
- Config ghi nguyên tử với mode 600 ngay từ đầu.
- `gdrive_download` từng ghi được file tuỳ ý trên máy từ MCP, kể cả ở readonly; đã bỏ khỏi MCP.
- `gdrive init` chạy lại không còn xoá danh sách `folders`.
- Lỗi ngoài phạm vi không còn nêu tên file nằm ngoài phạm vi.

## [0.3.0] - 2026-09-30

### Thêm

- Hỗ trợ Codex, GitHub Copilot (VS Code và CLI), Cursor, Kiro.
  `gdrive install --client <tên> [--project] [--skill]` ghi cấu hình MCP vào file của client,
  chỉ merge khoá `gdrive` và không ghi credential. `gdrive uninstall --client <tên>` gỡ đăng ký.
- `gdrive mcp` chạy MCP server qua stdio để client bất kỳ trỏ vào.
- Thư mục config dùng chung cho mọi client: `$GDRIVE_CONFIG_DIR`, `~/.config/gdrive-cli`, trên
  Windows là `%APPDATA%\gdrive-cli`. Máy có cả plugin Claude và client khác dùng chung một file.
- MCP server gửi hướng dẫn ngắn qua trường `instructions` trong `initialize`.
- `--skill` cài Agent Skill vào `~/.agents/skills/gdrive` (Kiro: `~/.kiro/skills/gdrive`).
- `gdrive status` liệt kê client đã đăng ký và báo đỏ khi đường dẫn trong config không còn.
- MCP server nạp lại cấu hình khi đang chạy, không cần mở session mới sau `gdrive init`.

### Sửa

- `CLAUDE_PLUGIN_DATA` của plugin khác bị bỏ qua. Trước đó `gdrive init` chạy trong Claude Code
  có thể ghi private key vào thư mục của plugin khác, và `uninstall --purge` có thể xoá nhầm
  `config.json` của plugin đó.
- Private key chỉ nằm trong đúng một file config. Trước đó key có thể bị ghi ra nhiều thư mục
  data của plugin.
- ADC và gcloud thành tuỳ chọn phải bật bằng `gdrive init --adc`. Trước đó, máy có gcloud đăng
  nhập sẵn thì plugin âm thầm chạy bằng tài khoản Google cá nhân và chế độ readonly không giới
  hạn được scope của token.
- Đóng stdin ngay sau tool call vẫn nhận đủ phản hồi, kể cả frame lớn trên Windows.

### Tài liệu

- README viết lại, có phần ưu nhược điểm và so sánh với connector Google Drive của Claude.
- Sửa hướng dẫn `npm i -g gdrive-cli`: tên đó trên npm là gói khác, phải cài từ GitHub.

## [0.2.0] - 2026-07-28

### Thêm

- Đóng gói thành plugin Claude Code gồm MCP server, skill `gdrive` và `gdrive-setup`, cùng CLI.
  Cài bằng `/plugin install gdrive@gdrive-cli`.
- Các tool MCP `gdrive_sheet_read`, `gdrive_read_document`, `gdrive_file_info`, `gdrive_list`,
  `gdrive_download`, và `gdrive_sheet_write`, `gdrive_upload` ở chế độ `readwrite`.

### Sửa

- Dò mọi thư mục data `gdrive*` của plugin thay vì đoán một tên cố định, để CLI và MCP server
  luôn thấy cùng một config.

## [0.1.1] - 2026-07-27

### Thêm

- Export `readTable`, `readDocument` và bộ đọc OOXML từ thư viện.

## [0.1.0] - 2026-07-27

### Thêm

- Bản đầu tiên: auth service account tự ký JWT không cần dependency, đọc Google Sheets, Docs,
  Slides và `.xlsx`, `.docx`, `.pptx` trên Drive.
- CLI `gdrive` và wizard cài đặt qua npx, skill cho Claude Code.

[Chưa phát hành]: https://github.com/sdc-ren/gdrive-cli/compare/v0.4.0...develop
[0.4.0]: https://github.com/sdc-ren/gdrive-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sdc-ren/gdrive-cli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sdc-ren/gdrive-cli/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/sdc-ren/gdrive-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sdc-ren/gdrive-cli/releases/tag/v0.1.0
