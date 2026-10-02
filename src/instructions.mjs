// Hướng dẫn gửi kèm `initialize` (trường MCP `instructions`). Ngắn và trung lập cho mọi
// client; bản đầy đủ nằm ở skills/gdrive/SKILL.md.

export const INSTRUCTIONS = `Google Drive via a service account. Pass the Google URL (or id) the user gives straight to a tool; it may be a file or a folder. Access follows Drive sharing: Editor = read/write, Viewer = read only.

Tools: drive_ls (folder contents), drive_read (any file: sheets as TSV with columns/where/offset/limit, docs as markdown), sheet_write (cells and/or append rows), drive_create (folder/doc/sheet), drive_move (rename/move). Write tools are hidden in readonly mode.

Read big sheets in pages: follow next=<offset> in the first line. Prefer columns/where over reading everything.

Errors start with ✗. 404 or 403 means it is not shared with the service account email shown: ask the user to share it (Viewer to read, Editor to write). "Chỉ đọc" means the service account is not Editor there. Never ask the user to paste key file contents.`;
