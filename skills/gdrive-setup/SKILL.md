---
name: gdrive-setup
description: Cấu hình credential cho plugin gdrive lần đầu, hoặc đổi service account / bật quyền ghi. Dùng khi tool drive_* báo "Không tìm thấy credential", "chưa share" hoặc "Chỉ đọc", khi người dùng nói "cài đặt gdrive", "cấu hình Google Drive", "đổi service account", "bật quyền ghi sheet", hoặc khi cần kiểm tra vì sao gdrive không truy cập được file.
version: 0.5.1
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
   `init` mặc định `--mode readwrite`: ghi được ở nơi service account là Editor. Người dùng muốn
   chặn ghi hoàn toàn thì thêm `--mode readonly`.

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

5. Nhờ người dùng share file hoặc folder cần dùng cho email ở bước 4: chọn **Editor** nếu muốn AI
   ghi, **Viewer** nếu chỉ cần đọc. Sau đó chỉ cần gửi link cho AI, không phải khai báo gì thêm.

6. Nhắc người dùng **mở session Claude Code mới** để MCP server nạp cấu hình.

## Đổi quyền

Quyền trên từng file hay folder đổi ngay trong Drive, ở hộp thoại Share: Editor để ghi, Viewer để
chỉ đọc. Folder con và file bên trong theo quyền share của folder cha như mọi tài khoản Google khác.

Khoá `mode` trong config là công tắc chung. `readonly` ẩn ba tool ghi (`sheet_write`,
`drive_create`, `drive_move`) ở mọi nơi; không thấy chúng thì đó là lý do. Config tạo từ v0.4 trở
về trước thường đang `readonly`. Bật ghi mà giữ key cũ:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" init --mode readwrite --yes
```

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
