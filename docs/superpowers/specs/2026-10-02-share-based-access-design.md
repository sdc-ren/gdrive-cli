# Thiết kế: quyền theo share trên Drive, bỏ danh sách folder (v0.5.0)

## Mục tiêu

Người dùng không phải khai báo folder. Họ gửi link (file, folder, Sheet, Doc…), AI mở thẳng
link đó với đúng quyền Drive đã cấp cho service account:

- **Editor** (hoặc thành viên Shared Drive quyền Contributor trở lên): đọc và ghi.
- **Viewer, Commenter**: chỉ đọc.
- Không được share: Drive trả 404/403, AI báo lại kèm email service account cần share.

Cài đặt còn hai bước: cài plugin hoặc CLI, rồi `gdrive init --sa-json <file>`.

Các quyết định của người dùng:
- Bỏ hẳn danh sách folder (phương án B).
- Không liệt kê "mọi thứ được share": người dùng luôn gửi link, liệt kê chỉ tốn thêm thời gian
  và request.

## Hiện trạng đo được (2026-10-02, Drive thật, service account của người dùng)

| Phép đo | Kết quả |
|---|---|
| `files.get` folder `gdriver` với `capabilities(canEdit,canAddChildren,canRename,canMoveItemWithinDrive)` | Đều `true` (service account là Editor) |
| `files.list q="sharedWithMe = true"` | 5 folder, khoảng 950 ms. Chỉ ghi lại để so sánh: thiết kế này **không** gọi |
| `drives.list` | Rỗng, khoảng 320 ms. Thiết kế này **không** gọi |

Chưa đo được trường hợp `canEdit=false` (chưa có gì share quyền Viewer). Theo tài liệu Drive v3,
`capabilities.canEdit` là `false` với vai trò reader và commenter. Task kiểm chứng trong plan
sẽ đo nếu người dùng share thử một mục quyền Viewer.

## Ràng buộc

- Giữ mọi ràng buộc của v0.4.0: không dependency, stdout chỉ có JSON-RPC, key chỉ nằm trong một
  file mode 600, test không gọi mạng, chạy được trên Windows.
- Drive là nơi quyết định quyền cuối cùng. Kiểm tra phía client chỉ để báo lỗi dễ hiểu và chặn
  trước khi gọi API ghi.
- Không thêm request nào so với việc mở link: quyền đọc từ `capabilities` nằm sẵn trong metadata
  (đã cache 5 phút).
- Giữ bộ chặn công thức `IMPORT*`/`IMAGE`: nó chặn kéo dữ liệu ra ngoài qua sheet, không phụ
  thuộc phạm vi folder.
- Schema tool dưới 700 token ước lượng (cổng CI hiện có).

## Ngoài phạm vi

- Liệt kê hay tìm kiếm mọi thứ được share; địa chỉ theo tên.
- Giới hạn theo client hay dự án. Muốn giới hạn thì dùng service account riêng, hoặc share ít hơn.
- Upload file từ máy, chia sẻ file cho người khác qua MCP.

## 1. Mô hình quyền

### Nguồn quyền

`META_FIELDS` thêm `capabilities(canEdit,canAddChildren)`. Mọi kiểm tra dùng metadata đã lấy khi
mở link, không gọi thêm API.

| Thao tác | Điều kiện kiểm phía client | Lỗi nếu thiếu |
|---|---|---|
| `sheet_write` | file `canEdit` | `✗ Chỉ đọc: service account chưa có quyền Editor với "<tên>".` |
| `drive_create` | folder cha `canAddChildren` | cùng mẫu, với tên folder cha |
| `drive_move` đổi tên | file `canEdit` | cùng mẫu |
| `drive_move` chuyển folder | file `canEdit`, folder đích `canAddChildren` | cùng mẫu, nêu mục thiếu quyền |

- Metadata không có `capabilities` thì coi như chỉ đọc.
- Shortcut được giải về file đích, và quyền lấy theo file đích.
- Không lần theo folder cha nữa. So với v0.4.0, mỗi file mới bớt được 1 đến vài request.

### Khoá `mode` trong config

`mode` làm khoá an toàn chung:

- `readwrite`: ghi được ở nơi Drive cho phép. Đây là mặc định mới của `gdrive init`. Config có
  credential mà thiếu `mode` cũng hiểu là `readwrite`.
- `readonly`: không ghi gì, kể cả nơi service account là Editor. Tool ghi bị ẩn và token xin scope
  `*.readonly`.
- Không có config: `readonly`.

Config cũ đang ghi `mode: readonly` (mặc định của `init` từ v0.2 tới v0.4) giữ nguyên, không tự
nới quyền. `gdrive status` gợi ý cách bật ghi: `gdrive init --mode readwrite --yes` (giữ key cũ, chỉ
đổi mode).

### Khoá `folders`, biến `GDRIVE_FOLDERS`, lệnh `gdrive folder`

- `folders` và `GDRIVE_FOLDERS` không còn tác dụng, bị bỏ qua mà không báo lỗi.
- `gdrive status` in một dòng `Khoá "folders" không còn dùng từ v0.5.0, có thể xoá.`
- `gdrive init` chạy lại thì xoá khoá `folders`.
- Lệnh `gdrive folder` bị bỏ. Gọi lệnh này thì in `Lệnh "folder" đã bỏ ở v0.5.0: quyền lấy theo
  share trên Drive.` rồi thoát mã 2.

## 2. Bộ tool MCP

Vẫn 5 tool, giữ tên. `target`, `path`, `parent`, `to` nhận **URL Google hoặc id**.

| Tool | Thay đổi |
|---|---|
| `drive_ls { path, query?, limit?, page? }` | `path` bắt buộc, là link folder. Link file thì báo `✗ "<tên>" không phải folder. Dùng drive_read để đọc.` Dòng đầu `# <tên folder> (write\|read) · N` theo `canEdit` của folder |
| `drive_read` | Bỏ kiểm phạm vi. Còn lại như cũ |
| `sheet_write`, `drive_create`, `drive_move` | Kiểm quyền theo bảng ở mục 1. `drive_move` bỏ bước bảo vệ folder gốc |

- `mode: readwrite` thì có đủ 5 tool, `mode: readonly` thì chỉ có `drive_ls` và `drive_read`.
  `tools/list` không gọi mạng.
- `drive_create` trên My Drive giữ quy tắc v0.4.0: tạo Doc/Sheet cần folder cha trên Shared Drive
  (service account không có dung lượng My Drive); tạo folder thì ở đâu cũng được.
- Lỗi 404/403 dùng `renderError` có sẵn:
  `✗ 404: chưa share cho <email> (Viewer để đọc, Editor để ghi).`
- `instructions` viết lại:
  - truyền nguyên link người dùng gửi;
  - 404/403 nghĩa là chưa share, nhờ người dùng share cho email service account;
  - "Chỉ đọc" nghĩa là chưa có quyền Editor;
  - bỏ alias và `folder add`.

## 3. CLI

| Lệnh | Thay đổi |
|---|---|
| `gdrive ls` không đích | Như trước v0.4.0: liệt kê file service account thấy (dùng tay, không qua AI) |
| `gdrive ls <url>` | Như cũ. `--query` dùng lại được |
| `read`, `doc`, `write`, `put`, `get`, `info` | Nhận URL hoặc id. Drive quyết định quyền, CLI in lỗi có sẵn |
| `write`, `put` | Cần `mode: readwrite` (hoặc `--mode readwrite` cho một lần chạy) |
| `folder …` | Bỏ (mục 1) |
| `status` | Bỏ phần folder. In mode thực tế kèm gợi ý khi đang readonly; nhắc khoá `folders` cũ |
| `init` | Mặc định `--mode readwrite`. Xoá khoá `folders`. Bỏ dòng gợi ý `folder add` |

## 4. Thay đổi mã nguồn

| File | Việc |
|---|---|
| `src/access.mjs` (mới, thay `scope.mjs`) | `modeFromConfig(cfg)`, `AccessError` (`READ_ONLY`, `NOT_FOUND`), `READONLY_HINT`, `createAccess({ meta, mode })` trả `resolve(input)`, `accessOf(meta)`, `assertCanEdit(meta)`, `assertCanAddChildren(meta)` |
| `src/meta.mjs` | `META_FIELDS` thêm `capabilities(canEdit,canAddChildren)`. Xoá `findChild` (chỉ scope dùng) |
| `src/render.mjs` | Xoá `renderFolders`. `renderError` xử lý `AccessError` |
| `src/tools.mjs` | `buildTools({ getClient, mode })` dùng `access` |
| `server/index.mjs` | Dựng tool theo `modeFromConfig`. Đổi `mode` thì gửi `tools/list_changed`. Bỏ `loadFolders` |
| `src/instructions.mjs` | Viết lại theo mục 2 |
| `src/cli-scope.mjs` | Chỉ còn `resolveCliMode({ flags, cfg, needWrite })` |
| `bin/cli.mjs` | Bỏ lệnh `folder` và các hàm folder. `ls` không đích về hành vi cũ |
| `src/status.mjs`, `src/init.mjs` | Như mục 3 |
| Xoá | `src/folders.mjs`, `src/folder-cli.mjs`, `src/scope.mjs` và test tương ứng |
| `bench/tokens.mjs` | `buildTools({ mode: 'readwrite' })` |

## 5. Kiểm thử

Test đơn vị dùng `client.api` giả như hiện tại.

- `access`:
  - URL và id phân giải đúng, `gid` giữ nguyên;
  - shortcut giải về đích, shortcut hỏng trả `NOT_FOUND`;
  - 404 của Drive ném lên nguyên vẹn;
  - `accessOf`, `assertCanEdit`, `assertCanAddChildren` theo `capabilities` và `mode`;
  - thiếu `capabilities` coi như chỉ đọc.
- Tool:
  - `sheet_write` trên file `canEdit=false`: `READ_ONLY`, không gọi API ghi;
  - `drive_create` với cha `canAddChildren=false`: `READ_ONLY`;
  - `drive_move` với đích `canAddChildren=false`: `READ_ONLY`;
  - shortcut từ folder ghi được trỏ tới file Viewer: `READ_ONLY`;
  - `drive_ls` không `path`: lỗi validate; link file: lỗi gợi ý `drive_read`.
- Server:
  - `mode: readonly` thì 2 tool; đổi sang `readwrite` thì bắn `list_changed` và có 5 tool;
  - config v0.4.0 (`readonly` + `folders`) cùng `GDRIVE_FOLDERS` vẫn chạy và bỏ qua cả hai.
- CLI:
  - `gdrive folder add` thoát mã 2;
  - `init` mặc định `readwrite`, xoá `folders`, giữ `readonly` khi chọn.
- Bộ chặn công thức giữ nguyên test.

Kiểm chứng thật (task cuối của plan):
- `drive_ls` và `drive_read` bằng link folder `gdriver` thật;
- link không share thì ra lỗi 404 kèm email;
- ghi thử sau khi người dùng đồng ý: tạo rồi đổi tên một folder con, và ghi một ô nếu có Sheet thử;
- có mục share quyền Viewer thì phải bị từ chối ghi.

## 6. Bảo mật và tài liệu

- AI ghi được mọi thứ service account là Editor. Muốn AI chỉ đọc thì share Viewer; muốn chặn ghi
  hoàn toàn thì đặt `mode: readonly`.
- Ai share nhầm thứ gì cho email service account thì AI cũng mở được nếu có link. Coi email đó là
  tài khoản riêng của AI.
- SECURITY.md, mục vượt quyền: thay "thoát phạm vi folder" bằng hai ý:
  - ghi được khi `mode: readonly`;
  - đọc hoặc ghi được file không share cho service account.
- README:
  - bỏ phần khai báo folder và `GDRIVE_FOLDERS`;
  - thêm bảng quyền (Editor/Viewer/không share/readonly);
  - thêm mục nâng cấp từ v0.4.0;
  - đo lại số request mỗi lần đọc.
- Phiên bản 0.5.0: bỏ lệnh `folder` và đổi mặc định. Bump ở 5 chỗ như các bản trước, cùng
  `test/version.test.mjs`.

## Kết quả kiểm chứng (2026-10-02)

Chạy MCP server thật với config của người dùng (`mode: readonly`, service account
`packflow-uploader@…`), Node 26, `GDRIVE_DEBUG=1`.

| Kiểm tra | Kết quả |
|---|---|
| `tools/list` ở readonly | `drive_ls,drive_read` |
| `drive_ls` link folder `gdriver` (có `?hl=vi`) | `# gdriver (read) · 1`, đọc đúng nội dung. Tốn 1 request metadata + 1 request list |
| `drive_ls` lần hai, cùng folder, truyền id | Metadata lấy từ cache: chỉ còn 1 request list |
| `drive_read` id không share | `✗ 404: chưa share cho packflow-uploader@… (Viewer để đọc, Editor để ghi).` Chỉ 1 request |
| Schema (tiktoken `o200k_base`) | readwrite 557 token (v0.4: 561), readonly 265 (không đổi), instructions 195 (v0.4: 196) |
| Ước lượng của bench | 681/700 |

So với v0.4.0, mở một file mới không còn đi ngược folder cha: v0.4.0 tốn thêm 1 request
`files.get` cho mỗi tầng folder (cache 10 phút), v0.5.0 không tốn request nào.

Phần ghi (tạo/đổi tên folder, ghi Sheet, từ chối trên mục Viewer) chưa chạy: chờ người dùng đồng ý.
