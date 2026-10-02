# Đóng góp cho gdrive-cli

Cảm ơn bạn muốn đóng góp. File này nói cách chạy dự án, cách gửi thay đổi, và vài nguyên tắc
mà mọi PR phải giữ.

## Nhánh

| Nhánh | Dùng để |
|---|---|
| `main` | Bản phát hành. Người dùng clone và cài từ đây. Chỉ nhận merge từ `develop` khi ra phiên bản mới. |
| `develop` | Phát triển. Mọi PR tính năng và sửa lỗi nhắm vào nhánh này. |

Chỉ maintainer được merge vào `develop` và `main`. Cả hai nhánh cấm force-push và cấm xoá, và
PR chỉ được merge khi CI xanh trên Linux, macOS, Windows với Node 18 và 22.

## Gửi một thay đổi

1. Fork repo, rồi tạo nhánh từ `develop`:

   ```bash
   git clone https://github.com/<bạn>/gdrive-cli.git
   cd gdrive-cli
   git switch develop
   git switch -c fix/mo-ta-ngan
   ```

2. Sửa code, thêm test, chạy `node --test`.
3. Mở PR vào `develop` và điền template PR.

Thay đổi lớn (thêm client mới, đổi định dạng config, thêm tool MCP) nên mở issue bàn trước để
không mất công làm một hướng sẽ không được nhận.

Đặt tên nhánh theo loại thay đổi: `feat/…`, `fix/…`, `docs/…`, `test/…`, `chore/…`. Commit
theo kiểu Conventional Commits (`feat: …`, `fix: …`, `docs: …`), viết tiếng Việt hoặc tiếng Anh
đều được.

## Chạy dự án

Cần Node.js 18.17 trở lên. Không có bước cài đặt vì gói không có dependency.

```bash
node --test                     # toàn bộ test, không cần mạng hay credential
node --test test/clients.test.mjs
node bin/cli.mjs --help         # chạy CLI từ mã nguồn
node bin/cli.mjs mcp            # chạy MCP server qua stdio
```

Thử với Google API thật thì cần service account riêng để test. Đừng dùng key của môi trường
production.

```bash
GDRIVE_CONFIG_DIR=/tmp/gdrive-dev node bin/cli.mjs init --sa-json ~/keys/test-sa.json
GDRIVE_CONFIG_DIR=/tmp/gdrive-dev node bin/cli.mjs status
```

`GDRIVE_CONFIG_DIR` giữ config thử tách khỏi config thật của bạn.

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `server/index.mjs` | MCP server (JSON-RPC qua stdio) |
| `bin/cli.mjs` | CLI `gdrive` |
| `src/tools.mjs` | Định nghĩa các tool MCP |
| `src/access.mjs` | Phân giải link, kiểm quyền ghi, mode |
| `src/config.mjs` | Tìm và ghi file config |
| `src/credentials.mjs`, `src/auth.mjs` | Lấy credential, ký JWT, đổi access token |
| `src/clients.mjs` | `gdrive install --client` cho Codex, Copilot, Cursor, Kiro |
| `src/ooxml-*.mjs`, `src/zip.mjs` | Đọc `.xlsx`, `.docx`, `.pptx` |
| `skills/` | Skill cho Claude Code và Agent Skill cho client khác |
| `test/` | Test chạy bằng `node --test` |

## Nguyên tắc phải giữ

Không thêm dependency. Mọi thứ dùng API có sẵn của Node. Nếu thật sự cần một thư viện, mở issue
bàn trước.

Stdout của MCP server chỉ chứa frame JSON-RPC. Server chuyển `console.log` sang stderr ngay dòng
đầu; đừng ghi thẳng ra `process.stdout` ở chỗ khác. Một dòng lạc là client báo lỗi kết nối.

Private key chỉ nằm trong đúng một file config, chmod 600. Không in key ra log, không đưa vào
kết quả tool, không ghi vào config của client AI. Lệnh nào nhận key thì nhận đường dẫn file,
không nhận nội dung qua tham số hay qua hội thoại.

Quyền do Drive quyết định qua share (`src/access.mjs`): Editor thì ghi, Viewer thì đọc. Tool ghi
kiểm `capabilities` trước khi gọi API và bị ẩn khi config `mode: readonly`.

Không phá file của người dùng. Code sửa file config của client phải merge đúng khoá của mình,
và khi không đọc chắc được file (JSONC, TOML mơ hồ) thì để nguyên file và in hướng dẫn.

Test phải chạy được trên Windows. Dùng `path.join` thay vì nối chuỗi `/`, so đường dẫn bằng
`join` trong test, và nhớ rằng git trên Windows có thể checkout file với CRLF.

Test không gọi mạng và không đọc config thật của máy. Dùng HOME tạm như các test có sẵn trong
`test/install.test.mjs`.

## Phát hành (dành cho maintainer)

1. Cập nhật `CHANGELOG.md` và version ở `package.json`, `.claude-plugin/plugin.json`,
   `SERVER_INFO` trong `server/index.mjs`, và hai file `skills/*/SKILL.md`.
2. Mở PR từ `develop` vào `main`. Merge khi CI xanh.
3. Gắn tag trên `main` rồi tạo GitHub Release từ mục tương ứng trong CHANGELOG:

   ```bash
   git switch main && git pull
   git tag -a v0.5.0 -m "v0.5.0"
   git push origin v0.5.0
   gh release create v0.5.0 --notes-file <ghi-chú.md>
   ```

## Báo lỗi và đề xuất

Dùng các template trong mục Issues. Lỗ hổng bảo mật thì báo riêng theo [SECURITY.md](SECURITY.md).
