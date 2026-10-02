# Thiết kế: quyền theo share trên Drive, bỏ danh sách folder (v0.5.0)

## Mục tiêu

Người dùng không phải khai báo folder nữa. Service account được share cái gì thì AI dùng được cái
đó, với đúng quyền Drive đã cấp:

- **Editor** (hoặc thành viên Shared Drive có quyền Contributor trở lên): đọc và ghi.
- **Viewer, Commenter**: chỉ đọc.
- Không được share: không thấy (Drive trả 404).

Cài đặt chỉ còn hai bước: cài plugin hoặc CLI, rồi `gdrive init --sa-json <file>`.

Người dùng đã chọn bỏ hẳn danh sách folder (phương án B), không giữ làm bộ lọc tuỳ chọn.

## Hiện trạng đo được (2026-10-02, Drive thật, service account của người dùng)

| Phép đo | Kết quả |
|---|---|
| `files.list q="sharedWithMe = true and trashed = false"` | 5 folder (gdriver, MMO-AI, Rồng Việt SPEC, Testing, Packflow_Test_Artifacts), đều `capabilities.canEdit=true`. Khoảng 950 ms |
| `drives.list` | Rỗng, khoảng 320 ms. Service account chưa là thành viên Shared Drive nào |
| `files.get gdriver` với `capabilities(canEdit,canAddChildren,canRename,canMoveItemWithinDrive)` | Đều `true` |
| `files.list q="'me' in owners"` | Chỉ thấy folder do service account tạo, và đều nằm bên trong folder đã được share. Không có gốc riêng |

Chưa đo được trường hợp `canEdit=false`, vì chưa có folder nào share quyền Viewer. Task kiểm chứng
trong plan sẽ đo nếu người dùng share thử một folder Viewer. Nếu không, dựa vào tài liệu Drive v3:
`capabilities.canEdit` là `false` với vai trò reader và commenter.

## Ràng buộc

- Giữ mọi ràng buộc của v0.4.0: không dependency, stdout chỉ có JSON-RPC, key chỉ nằm trong một
  file mode 600, test không gọi mạng, chạy được trên Windows.
- Drive là nơi quyết định quyền cuối cùng. Kiểm tra phía client chỉ để báo lỗi dễ hiểu và chặn sớm;
  nếu bỏ sót thì Drive vẫn trả 403.
- Giữ bộ chặn công thức `IMPORT*`/`IMAGE`. Lý do: chặn kéo dữ liệu ra ngoài qua sheet. Lý do này
  không phụ thuộc phạm vi folder.
- Schema tool dưới 700 token ước lượng (cổng CI hiện có).

## Ngoài phạm vi

- Chọn folder cho từng client hay từng dự án. Muốn giới hạn thì dùng service account riêng, hoặc
  share ít hơn.
- Upload file từ máy qua MCP, chia sẻ file cho người khác qua MCP.
- Domain-wide delegation.

## 1. Mô hình quyền

### Nguồn quyền

Mỗi file đã có `capabilities` từ Drive. Thêm `capabilities(canEdit,canAddChildren)` vào
`META_FIELDS`, nên cache metadata 5 phút hiện có tự mang theo quyền và không tốn request thêm.

| Thao tác | Điều kiện kiểm phía client | Lỗi nếu thiếu |
|---|---|---|
| `sheet_write` | file đích `canEdit` | `✗ Chỉ đọc: service account chưa có quyền Editor với "<tên>".` |
| `drive_create` | folder cha `canAddChildren` | cùng mẫu, với tên folder cha |
| `drive_move` đổi tên | file `canEdit` | cùng mẫu |
| `drive_move` chuyển folder | file `canEdit` và folder đích `canAddChildren` | cùng mẫu, nêu folder nào thiếu |

Không lần theo folder cha nữa: file nào mở được bằng `files.get` thì nằm trong phạm vi. Mỗi lần
đọc file chưa có trong cache bớt được 1 đến vài request so với v0.4.0.

Shortcut vẫn được giải về file đích. Đích không share cho service account thì Drive trả 404.

### Khoá `mode` trong config

`mode` quay lại làm khoá an toàn chung:

- `readwrite`: ghi được ở những nơi Drive cho phép. Đây là **mặc định mới** của `gdrive init`.
- `readonly`: không ghi gì cả, kể cả nơi service account là Editor. Tool ghi bị ẩn và token chỉ xin
  scope `*.readonly`.

Config cũ đang ghi `mode: readonly` (mặc định của `init` từ v0.2 đến v0.4) **giữ nguyên**: không tự
nới quyền cho người đã có config. Khi đang ở `readonly`, `gdrive status` và dòng đầu của `drive_ls`
gợi ý cách bật ghi: `gdrive init --mode readwrite --yes` (giữ key cũ, chỉ đổi mode).

### Khoá `folders` và biến `GDRIVE_FOLDERS`

- Không còn tác dụng. Server và CLI bỏ qua, không báo lỗi.
- `gdrive status` in một dòng: `Khoá "folders" không còn dùng từ v0.5.0, có thể xoá.`
- `gdrive init` chạy lại thì xoá khoá `folders` khỏi config.

### Lệnh `gdrive folder`

Bỏ. Gọi lệnh này thì in `Lệnh "folder" đã bỏ ở v0.5.0: quyền lấy theo share trên Drive. Xem gdrive
ls.` rồi thoát với mã 2.

## 2. Bộ tool MCP

Vẫn 5 tool, giữ tên và tham số. Các thay đổi:

### `drive_ls` không tham số: liệt kê gốc

Gốc gồm:
1. Shared Drive mà service account là thành viên (`drives.list`).
2. File và folder share trực tiếp (`files.list q="sharedWithMe = true and trashed = false"`).

Gọi hai request song song, lấy tối đa 1000 gốc (`sharedWithMe` đi hết các trang tới mức đó). Danh
sách cache 5 phút trong tiến trình server; `drive_create` và `drive_move` xoá cache này.

```
# 6 shared · readwrite
D Team Drive (write) 0AAbc…
d gdriver (write) 1xmedZmMAN7at08zCYDgy5l4WjKC6cwrV
d Rồng Việt SPEC (read) 1Abc…
s Báo cáo tuần (read) 1Def…
```

- Mã `D` là Shared Drive; các mã khác giữ như `typeCode` hiện có.
- `(write)` khi `canEdit` (Shared Drive: `capabilities.canAddChildren`), ngược lại là `(read)`.
- Ở `mode: readonly` mọi dòng là `(read)`, và tiêu đề có thêm `· readonly — bật ghi: gdrive init
  --mode readwrite --yes`.
- `query` lọc theo tên (không phân biệt hoa thường) trên danh sách đã cache, không tốn request.
- `limit` mặc định 30, tối đa 200. `page` là offset trong danh sách: dòng đầu có `next=<offset>`
  khi còn, giống phân trang của `drive_read`.
- Danh sách rỗng: tiêu đề là `# 0 shared · share folder cho email service account (xem gdrive status)`.

### `drive_ls { path }` và các tool khác: địa chỉ file

`target` nhận một trong ba dạng:
- URL Google.
- Id trần.
- `tên-gốc/đường/dẫn`, với `tên-gốc` khớp chính xác tên một dòng trong danh sách gốc.

Cách phân giải, theo thứ tự (để đọc bằng id không phải tải danh sách gốc):
1. Có `:` thì là URL.
2. Không có `/` và trông như id (`[A-Za-z0-9_-]{8,}`) thì đọc như id. Drive trả 404 thì thử bước 3.
   Bước 3 cũng không khớp thì báo lỗi 404 ban đầu (chưa share).
3. Còn lại: đoạn trước `/` đầu tiên phải khớp chính xác tên một gốc. Khớp đúng một thì đi tiếp
   theo đường dẫn bằng `findChild` như v0.4.0. Khớp nhiều gốc thì báo `✗ Có 2 mục tên "X": dùng id
   <id1> hoặc <id2>.` Không khớp gốc nào thì báo `✗ Không có mục nào tên "X" được share. Gọi
   drive_ls để xem.`

Tên gốc có thể chứa khoảng trắng hoặc dấu tiếng Việt, và vẫn khớp bình thường.

Dòng đầu của `drive_ls { path }` hiện `(write)` hoặc `(read)` theo `canEdit` của chính folder đó.

### Tool ghi hiện ra khi nào

`mode: readwrite` thì luôn liệt kê đủ 5 tool, không gọi mạng lúc `tools/list`. Tool ghi trên file
chỉ đọc thì báo lỗi theo bảng ở mục 1. `mode: readonly` thì chỉ có `drive_ls` và `drive_read`.

`instructions` viết lại: bỏ alias và `folder add`, nói rõ quyền theo share, và lỗi 404 nghĩa là chưa
share.

### `drive_create` trên My Drive

Giữ quy tắc v0.4.0: tạo Doc hoặc Sheet cần folder cha nằm trên Shared Drive (service account không
có dung lượng My Drive). Tạo folder thì chỗ nào cũng được.

## 3. CLI

| Lệnh | Thay đổi |
|---|---|
| `gdrive ls` không đích | In danh sách gốc như `drive_ls` (cùng hàm). `--json` trả `{ roots: [...] }` |
| `gdrive ls <url>` | Như cũ. `--query` dùng lại được (v0.4.0 cấm khi có folders) |
| `read`, `doc`, `write`, `put`, `get`, `info` | Nhận URL hoặc id như trước v0.4.0. Không có địa chỉ theo tên gốc |
| `write`, `put` | Cần `mode: readwrite`. Drive chặn nếu chỉ là Viewer, CLI in lỗi 403 có sẵn |
| `folder …` | Bỏ (xem mục 1) |
| `status` | Bỏ phần folder. In số gốc được share và bao nhiêu gốc ghi được, khi gọi thử API thành công |
| `init` | Mặc định `--mode readwrite`. Xoá khoá `folders`. Bỏ dòng gợi ý `folder add` |

## 4. Thay đổi mã nguồn

| File | Việc |
|---|---|
| `src/access.mjs` (mới, thay `scope.mjs`) | `createAccess({ client, meta, mode, now })` trả `roots({ query, limit, page })`, `resolve(input)`, `assertCanEdit(meta)`, `assertCanAddChildren(meta)`, `invalidate()`. `AccessError` có `code` (`READ_ONLY`, `NOT_FOUND`, `AMBIGUOUS`) |
| `src/drive.mjs` | Thêm `listSharedWithMe(client, { nameContains, max, pageToken })` và `listDrives(client, { nameContains })` |
| `src/meta.mjs` | `META_FIELDS` thêm `capabilities(canEdit,canAddChildren)` |
| `src/render.mjs` | `renderRoots({ roots, mode, next })` thay `renderFolders`. `renderError` coi `AccessError` như `ScopeError` cũ |
| `src/tools.mjs` | `buildTools({ getClient, mode })`. Bỏ tham số `folders` và bước bảo vệ folder gốc trong `drive_move` |
| `server/index.mjs` | Đọc `mode` từ config. Đổi `mode` thì gửi `tools/list_changed`. Bỏ `loadFolders` |
| `src/instructions.mjs` | Viết lại theo mục 2 |
| `src/cli-scope.mjs` | Chỉ còn `resolveCliMode({ flags, cfg, needWrite })` |
| `bin/cli.mjs` | Bỏ lệnh `folder`, `cliFolders`, `assertCliQueryAllowed`. `ls` không đích gọi `access.roots` |
| `src/status.mjs`, `src/init.mjs` | Như mục 3 |
| Xoá | `src/folders.mjs`, `src/folder-cli.mjs`, `src/scope.mjs` và test tương ứng |
| `bench/tokens.mjs` | `buildTools({ mode: 'readwrite' })` |

## 5. Kiểm thử

Test đơn vị dùng `fetchImpl` hoặc `client.api` giả như hiện tại:

- `access.roots`:
  - gộp Shared Drive và `sharedWithMe`;
  - nhãn `read`/`write` theo capabilities, và `mode: readonly` ép mọi nhãn thành `read`;
  - `query` lọc cả hai nguồn, `limit` cắt tổng;
  - cache 5 phút, `invalidate()` xoá cache.
- `access.resolve`:
  - URL, id, `tên-gốc/a/b`;
  - tên gốc có khoảng trắng;
  - gốc trùng tên trả `AMBIGUOUS`;
  - shortcut giải về đích;
  - đoạn không có thì trả `NOT_FOUND`.
- `sheet_write` trên file `canEdit=false`: lỗi `READ_ONLY`, **không** gọi API ghi nào.
- `drive_create` với cha `canAddChildren=false`, `drive_move` với đích `canAddChildren=false`:
  cùng kết quả.
- `mode: readonly`: `tools/list` chỉ có 2 tool. Đổi config sang `readwrite` thì server gửi
  `list_changed` và liệt kê 5 tool.
- Config có `folders` và env `GDRIVE_FOLDERS`: server chạy bình thường, bỏ qua cả hai.
- CLI:
  - `gdrive folder add` thoát mã 2 với thông báo đã bỏ;
  - `init` mặc định `readwrite`, xoá `folders`, và giữ `readonly` nếu truyền `--mode readonly`.
- Bộ chặn công thức giữ nguyên test.

Kiểm chứng thật (Task cuối trong plan): `drive_ls` liệt kê 5 folder ở trên. Đọc một sheet trong
`gdriver`. Ghi 1 ô rồi `append` 1 dòng vào một sheet thử (cần người dùng tạo Sheet trống). Tạo rồi
đổi tên một folder con. Nếu có folder share Viewer: `sheet_write` phải bị từ chối.

## 6. Bảo mật và tài liệu

Hệ quả cần ghi rõ trong README và SECURITY:

- AI ghi được **mọi** thứ service account là Editor. Muốn AI chỉ đọc một folder thì share quyền
  Viewer. Muốn chặn ghi hoàn toàn thì dùng `mode: readonly`.
- Ai share nhầm thứ gì cho email service account thì AI cũng thấy. Email này nên coi như tài khoản
  riêng của AI, không dùng lại cho việc khác.

SECURITY.md, mục vượt quyền: thay "thoát phạm vi folder" bằng:
- ghi được khi đang ở `mode: readonly`;
- tool đọc hoặc ghi được file không share cho service account.

README:
- Bỏ phần khai báo folder và `GDRIVE_FOLDERS`.
- Thêm bảng quyền (Editor/Viewer/không share) và mục nâng cấp từ v0.4.0: xoá `folders` thì tuỳ,
  bật ghi bằng `gdrive init --mode readwrite --yes`.
- Đo lại token của `drive_ls` gốc.

Phiên bản 0.5.0, vì bỏ lệnh `folder` và đổi hành vi mặc định. Bump ở 5 chỗ như các bản trước, cùng
`test/version.test.mjs`.
