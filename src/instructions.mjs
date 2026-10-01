// Hướng dẫn gửi kèm `initialize` (trường MCP `instructions`). Ngắn và trung lập cho mọi
// client; bản đầy đủ nằm ở skills/gdrive/SKILL.md.

export const INSTRUCTIONS = `Google Drive via a service account, limited to allowed folders. Call drive_ls with no args first to see folder aliases and access.

Tools: drive_ls (folders / folder contents), drive_read (any file: sheets as TSV with columns/where/offset/limit, docs as markdown), sheet_write (cells and/or append rows), drive_create (folder/doc/sheet), drive_move (rename/move). Write tools exist only when a folder has write access.

Targets accept an alias (test-run), alias/path/file, a Google URL, or an id. Read big sheets in pages: follow next=<offset> in the first line. Prefer columns/where over reading everything.

Errors start with ✗. "ngoài phạm vi" means the file is outside allowed folders: ask the user to run \`gdrive folder add <url>\`. 403 means the folder is not shared with the service account email shown. Never ask the user to paste key file contents.`;
