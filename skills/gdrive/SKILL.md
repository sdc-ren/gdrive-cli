---
name: gdrive
description: Dùng khi làm việc với Google Drive — người dùng dán link docs.google.com (spreadsheets/document/presentation) hoặc drive.google.com, hoặc nói "đọc sheet này", "lấy dữ liệu từ Google Sheet", "đọc file docx/xlsx/slide trên Drive", "ghi kết quả vào sheet", "upload lên Drive", "tìm file trên Drive". Kèm cách xử lý 3 lỗi hay gặp nhất (403 chưa share, quota Shared Drive, file Office đời cũ).
version: 0.2.0
---

# Google Drive qua service account

Các tool `gdrive_*` đã sẵn sàng — dùng thẳng, **mọi tool nhận link dán vào nguyên văn**, không
cần tự bóc file id hay gid.

## Chọn tool nào

| Loại | Tool |
|---|---|
| Google Sheets, `.xlsx` trên Drive | `gdrive_sheet_read` |
| Google Docs, Slides, `.docx`, `.pptx`, `.csv`, `.txt`, `.md` | `gdrive_read_document` |
| PDF, ảnh, định dạng khác | `gdrive_download` rồi đọc file đã tải |
| Chưa chắc file là gì | `gdrive_file_info` **trước** — rẻ hơn nhiều so với đoán sai rồi ăn lỗi |

`gdrive_sheet_read` luôn trả kèm **danh sách mọi tab + gid**. Đoán nhầm tab thì gọi lại với
tham số `sheet`, không cần tool phụ để dò.

## Ba lỗi hay gặp — biết trước thì khỏi loay hoay

**403 / không có quyền.** Service account là **một danh tính riêng có email riêng**; nó không
thấy gì cho tới khi được share. Lỗi trả về kèm sẵn email đó — đưa cho người dùng và bảo họ
Share (Viewer để đọc, Editor để ghi). **Không có cách vòng nào khác**, đừng thử tool khác.

**403 `storageQuotaExceeded` khi upload.** Service account **không có dung lượng My Drive**.
Đích upload phải nằm trên **Shared Drive**; share Editor một thư mục My Drive là không đủ.

**`.doc` / `.xls` / `.ppt` đời cũ.** Không đọc được (nhị phân OLE2) và **cố ý không hỗ trợ** —
parser nửa vời trả ra chữ trông có vẻ đúng nhưng sai, nguy hiểm hơn báo lỗi thẳng. Bảo người
dùng mở trong Drive → File → "Lưu dưới dạng Google Docs/Sheets" rồi đưa link bản mới.

## Vài điều nên làm

- Kết quả có trường `warnings` (nội dung bị cắt, header/footer không trích được, có tracked
  changes…) → **nói lại cho người dùng**, đừng lặng lẽ bỏ qua.
- Link "Publish to the web" (`/d/e/2PACX-…`) **không chứa file id** — bảo người dùng mở file
  rồi copy link trên thanh địa chỉ.
- Không thấy tool `gdrive_sheet_write` / `gdrive_upload` nghĩa là plugin đang ở chế độ
  **readonly**. Muốn ghi với bản plugin thì người dùng chạy
  `node "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" init --mode readwrite`. Server sẽ báo đổi danh sách
  tool; client hỗ trợ `listChanged` sẽ lấy lại tool ghi ở request kế tiếp, client không hỗ trợ
  thì mở session mới.
- Chưa cấu hình credential → chạy skill `gdrive-setup`.
