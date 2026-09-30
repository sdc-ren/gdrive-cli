// Hướng dẫn gửi kèm `initialize` (trường MCP `instructions`) — client nào hỗ trợ sẽ đưa vào
// system prompt. Giữ NGẮN và TRUNG LẬP: dùng chung cho Claude Code, Codex, Copilot, Cursor,
// Kiro…; Claude Code cắt bớt instructions dài. Bản đầy đủ nằm ở skills/gdrive/SKILL.md.

export const INSTRUCTIONS = `Google Drive qua service account. Mọi tool gdrive_* nhận nguyên link dán vào, không cần bóc file id/gid.

Chọn tool:
- Google Sheets, .xlsx: gdrive_sheet_read (luôn trả kèm danh sách tab + gid; sai tab thì gọi lại với tham số sheet).
- Google Docs/Slides, .docx, .pptx, .csv, .txt, .md: gdrive_read_document.
- PDF, ảnh, định dạng khác: gdrive_download rồi đọc file đã tải.
- Chưa rõ file là gì: gdrive_file_info trước.

Lỗi hay gặp:
- 403/404: service account là danh tính riêng, chỉ thấy file được share cho email của nó. Đưa email trong lỗi cho người dùng và bảo họ Share (Viewer để đọc, Editor để ghi). Không có cách vòng.
- storageQuotaExceeded khi upload: service account không có dung lượng My Drive, đích phải là Shared Drive.
- .doc/.xls/.ppt đời cũ: cố ý không hỗ trợ. Bảo người dùng lưu thành Google Docs/Sheets rồi đưa link mới.

Kết quả có warnings thì nói lại cho người dùng. Không thấy gdrive_sheet_write/gdrive_upload nghĩa là đang readonly; bật ghi: gdrive init --mode readwrite. Chưa có credential: gdrive init --sa-json <đường-dẫn-key.json>. Không bao giờ hỏi người dùng dán nội dung file key vào chat.`;
