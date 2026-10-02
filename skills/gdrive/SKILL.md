---
name: gdrive
description: Dùng khi làm việc với Google Drive — người dùng dán link docs.google.com hoặc drive.google.com, hoặc nói "đọc sheet này", "lấy dữ liệu từ Google Sheet", "đọc file docx/xlsx/slide trên Drive", "ghi kết quả vào sheet", "tạo doc/sheet trong folder", "tìm file trong folder". Kèm cách xử lý lỗi 404/403 chưa share, "Chỉ đọc", và file Office đời cũ.
version: 0.5.0
---

# Google Drive qua service account, quyền theo share

Người dùng gửi link, bạn truyền nguyên link đó (hoặc id) vào tool. Quyền do Drive quyết định theo
cách file được share cho email service account: Editor thì đọc và ghi, Viewer thì chỉ đọc. Không có
danh sách folder hay tên gợi nhớ nào cần tra trước.

## Chọn tool nào

| Việc | Tool |
|---|---|
| Xem nội dung một folder (cần link folder) | `drive_ls` |
| Đọc bất kỳ file nào: Sheet/xlsx ra TSV, Doc/Slide/docx/pptx ra markdown | `drive_read` |
| Ghi ô hoặc thêm dòng vào Google Sheet | `sheet_write` |
| Tạo folder, Google Doc (từ markdown), Google Sheet (từ CSV/TSV) | `drive_create` |
| Đổi tên, chuyển file sang folder khác | `drive_move` |

Mọi `target`, `path`, `parent`, `to` nhận link Google dán nguyên hoặc id. `drive_ls` chỉ nhận link
folder; người dùng đưa link file thì dùng `drive_read`.
Không thấy `sheet_write`, `drive_create`, `drive_move` nghĩa là config đang `mode: readonly`.

## Đọc sheet lớn mà không đổ cả bảng vào context

- Dòng đầu của kết quả có `tabs: …` và `rows a-b/total · next=<offset>`. Đọc tiếp bằng
  `offset: <next>`.
- Chỉ lấy cột cần: `columns: ["ID","Trạng thái"]`. Chỉ lấy dòng cần: `where: {"Trạng thái":"FAIL"}`.
- Mặc định 200 dòng một trang, tối đa 2000.

## Lỗi hay gặp

Lỗi luôn bắt đầu bằng `✗`.

- **404 hoặc 403 chưa share.** Service account có email riêng (hiện trong lỗi). Nhờ người dùng
  share file hoặc folder cho email đó, Viewer để đọc, Editor để ghi, rồi thử lại. Không có cách vòng.
- **Chỉ đọc.** Service account chưa có quyền Editor với mục đó. Nhờ người dùng đổi quyền share
  sang Editor nếu muốn ghi.
- **Chế độ readonly.** Config đang khoá ghi. Người dùng bật bằng `gdrive init --mode readwrite --yes`.
- **Chưa chắc đã ghi.** Mất kết nối giữa lúc thêm dòng. Đọc lại cuối bảng bằng `drive_read`
  trước khi gọi lại `sheet_write`, kẻo ghi trùng.
- **storageQuotaExceeded.** Service account không có dung lượng My Drive. `drive_create` chỉ
  chạy trong folder trên Shared Drive; `sheet_write` vào sheet có sẵn không bị giới hạn này (quota chỉ chặn tạo file mới).
- **`.doc` / `.xls` / `.ppt` đời cũ.** Cố ý không hỗ trợ. Bảo người dùng mở trong Drive, chọn
  File > Save as Google Docs/Sheets/Slides rồi đưa link mới.

## Nên làm

- Kết quả có dòng `# warnings:` thì nói lại cho người dùng.
- Link "Publish to the web" (`/d/e/2PACX-…`) không chứa file id; bảo người dùng copy link trên
  thanh địa chỉ khi mở file.
- Không bao giờ hỏi người dùng dán nội dung file key. Chưa có credential thì người dùng chạy
  `gdrive init --sa-json <đường-dẫn-key.json>` (Claude Code: skill `gdrive-setup`).
