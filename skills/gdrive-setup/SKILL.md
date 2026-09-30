---
name: gdrive-setup
description: Cấu hình credential cho plugin gdrive lần đầu, hoặc đổi service account / bật chế độ ghi. Dùng khi tool gdrive_* báo "Không tìm thấy credential", khi người dùng nói "cài đặt gdrive", "cấu hình Google Drive", "đổi service account", "bật quyền ghi sheet", hoặc khi cần kiểm tra vì sao gdrive không truy cập được file.
version: 0.3.0
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

2. **Có rồi** → chạy (mặc định readonly cho an toàn):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" init --sa-json "<đường-dẫn>" --mode readonly --yes
   ```
   Cần ghi sheet / upload thì đổi `--mode readwrite`. Hỏi người dùng trước khi bật ghi.

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

5. Nhắc người dùng **mở session Claude Code mới** để MCP server nạp cấu hình.

## Đổi chế độ đọc/ghi

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" init --mode readwrite --yes --no-test
```

Giữ nguyên credential đang có, chỉ đổi scope. Ở `readonly`, hai tool `gdrive_sheet_write` và
`gdrive_upload` **bị ẩn hẳn** khỏi danh sách tool — đó là chủ ý, không phải lỗi.

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
