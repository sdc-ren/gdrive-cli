---
name: gdrive
description: Dùng khi làm việc với Google Drive — người dùng dán link docs.google.com hoặc drive.google.com, hoặc nói "đọc sheet này", "lấy dữ liệu từ Google Sheet", "đọc file docx/xlsx/slide trên Drive", "ghi kết quả vào sheet", "tạo doc/sheet trong folder", "tìm file trong folder". Kèm cách xử lý lỗi ngoài phạm vi folder, 403 chưa share, và file Office đời cũ.
version: 0.4.0
---

# Google Drive qua service account, giới hạn theo folder

Plugin chỉ thấy các folder người dùng đã cho phép. Bắt đầu bằng `drive_ls` không tham số để biết
tên gợi nhớ (alias) và quyền của từng folder.

## Chọn tool nào

| Việc | Tool |
|---|---|
| Xem folder được phép, hoặc nội dung một folder | `drive_ls` |
| Đọc bất kỳ file nào: Sheet/xlsx ra TSV, Doc/Slide/docx/pptx ra markdown | `drive_read` |
| Ghi ô hoặc thêm dòng vào Google Sheet | `sheet_write` |
| Tạo folder, Google Doc (từ markdown), Google Sheet (từ CSV/TSV) | `drive_create` |
| Đổi tên, chuyển file sang folder khác | `drive_move` |

Mọi `target` nhận alias (`test-run`), đường dẫn `test-run/sub/file`, link Google dán nguyên, hoặc id.
Không thấy `sheet_write`, `drive_create`, `drive_move` nghĩa là không folder nào có quyền `write`.

## Đọc sheet lớn mà không đổ cả bảng vào context

- Dòng đầu của kết quả có `tabs: …` và `rows a-b/total · next=<offset>`. Đọc tiếp bằng
  `offset: <next>`.
- Chỉ lấy cột cần: `columns: ["ID","Trạng thái"]`. Chỉ lấy dòng cần: `where: {"Trạng thái":"FAIL"}`.
- Mặc định 200 dòng một trang, tối đa 2000.

## Lỗi hay gặp

Lỗi luôn bắt đầu bằng `✗`.

- **Ngoài phạm vi.** File không nằm trong folder được phép. Không có cách vòng: bảo người dùng
  chạy `gdrive folder add <link-folder> [--access write]` rồi thử lại.
- **Chỉ đọc.** Folder có quyền `read`. Người dùng bật ghi bằng `gdrive folder set <tên> --access write`.
- **403 chưa share.** Service account có email riêng (hiện trong lỗi); người dùng phải Share
  folder cho email đó, Viewer để đọc, Editor để ghi.
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
