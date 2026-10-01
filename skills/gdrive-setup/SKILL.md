---
name: gdrive-setup
description: Cấu hình credential và danh sách folder cho plugin gdrive lần đầu, hoặc đổi service account / thêm folder / bật quyền ghi cho folder. Dùng khi tool drive_* báo "Không tìm thấy credential" hoặc "ngoài phạm vi", khi người dùng nói "cài đặt gdrive", "cấu hình Google Drive", "đổi service account", "thêm folder", "bật quyền ghi sheet", hoặc khi cần kiểm tra vì sao gdrive không truy cập được file.
version: 0.4.0
---

# Cấu hình gdrive

## Nguyên tắc bắt buộc

**KHÔNG bao giờ hỏi người dùng dán nội dung file JSON key vào chat.** Private key không được
đi qua cuộc hội thoại. Chỉ hỏi **đường dẫn** tới file — CLI tự đọc, bạn không nhìn thấy nội dung.

## Đã cấu hình chưa

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" status
```

Xanh hết là xong, không cần làm gì thêm.

## Cấu hình lần đầu

1. Hỏi người dùng: *"Bạn đã có file JSON key của service account chưa? Nếu có, cho tôi đường
   dẫn tới file đó."*

2. **Có rồi** → chạy:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" init --sa-json "<đường-dẫn>" --yes
   ```
   Quyền đọc/ghi đặt theo từng folder ở bước 5.

3. **Chưa có** → đưa hướng dẫn này rồi chờ họ tải file về:

   - Vào https://console.cloud.google.com/ → tạo project (hoặc chọn project sẵn có)
   - Bật **cả hai** API:
     - https://console.cloud.google.com/apis/library/drive.googleapis.com
     - https://console.cloud.google.com/apis/library/sheets.googleapis.com
   - IAM & Admin → Service Accounts → Create → Done (không cần cấp role nào)
   - Bấm vào service account vừa tạo → tab **Keys** → Add key → Create new key → **JSON**

4. Sau khi `init` chạy xong, nó in ra **email của service account**. Nói rõ với người dùng:

   > Service account là một danh tính riêng. Nó **không thấy gì** trong Drive của bạn cho tới
   > khi bạn Share file/thư mục cho email này — Viewer để đọc, Editor để ghi. Y như share cho
   > một đồng nghiệp.

5. Hỏi người dùng folder nào plugin được phép đọc, folder nào được ghi, rồi thêm từng folder:
   ```bash
   gdrive folder add "<link-folder>" --access read
   gdrive folder add "<link-folder-ket-qua>" --access write
   ```
   (bản plugin Claude Code: `node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" folder add …`). Lệnh báo lỗi
   nếu folder chưa được share cho email ở bước 4. Chưa có folder nào thì mọi tool từ chối.

6. Nhắc người dùng **mở session Claude Code mới** để MCP server nạp cấu hình.

## Đổi quyền từng folder

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" folder list
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" folder set <tên> --access write
```

Folder con ở mọi độ sâu theo quyền của folder đã thêm. Ba tool ghi (`sheet_write`, `drive_create`,
`drive_move`) chỉ hiện khi có ít nhất một folder `write`; không thấy chúng thì đó là chủ ý.
Khoá `mode` cũ (`readonly`/`readwrite`, đặt bằng `init --mode`) không còn tác dụng khi đã có folder.
Bỏ một folder khỏi danh sách: `folder remove <tên>`.

## Dọn bản cài kiểu cũ

Ai từng cài bằng `npx github:dangchison/gdrive-cli` (trước v0.2) còn 4 chỗ rải rác dưới
`~/.claude`. Dọn:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" uninstall --purge
```

## Khi vẫn không truy cập được

Chạy `status` và đọc kỹ dòng đỏ. Hai nguyên nhân chiếm gần hết:

- **Chưa share file cho email service account** — không có cách nào khác ngoài share.
- **Chưa bật Drive API / Sheets API** trong GCP project — lỗi có chữ `SERVICE_DISABLED`.
