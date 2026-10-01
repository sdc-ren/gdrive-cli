# Thiết kế: gdrive-cli giới hạn theo folder, ít token, chạy ổn định (v0.4.0)

Ngày: 2026-10-01 · Trạng thái: đã duyệt (cập nhật sau review code cùng ngày)

## Mục tiêu

Người dùng cần một plugin cho trợ lý AI đọc và ghi dữ liệu **chỉ trong các folder Drive họ
chỉ định**, tốn ít token hơn connector Google Drive của Claude, và chạy ổn định khi agent đọc
sheet lớn hoặc ghi kết quả liên tục. README phải giải thích rõ các điểm này cho người mới.

Tiêu chí thành công:

1. Không đọc hay ghi được file nằm ngoài danh sách folder, kể cả khi service account có quyền.
2. Tổng schema của các tool MCP dưới 700 token (ước lượng theo byte, xem mục Đo token). Hiện
   tại là 764 token cho 5 tool đọc; connector là 3.610.
3. Đọc một trang 200 dòng của sheet tốn ít token hơn connector đọc cùng dữ liệu.
4. Ghi kết quả lặp lại không lỗi vì giới hạn tốc độ của Drive và không tạo dòng trùng.

## Hiện trạng đo được (2026-10-01, Drive thật)

Số liệu này là mốc so sánh cho mọi thay đổi bên dưới.

- Mỗi tool call có 2–4 request tuần tự tới Google, mỗi request 400–600 ms, không cache:
  `sheet_read` 1,3–1,5 giây dù chỉ đọc 10 ô; lần đầu 2,5 giây (lấy token). `list` 0,8 giây.
- Token (tiktoken o200k_base): schema 5 tool + instructions ≈ 1.070, connector Drive ≈ 3.610.
  Đọc file thì gdrive đang tốn hơn connector 5–35% vì JSON thụt lề và nội dung slide bị trả hai
  lần (`slides` cạnh `content`).
- Lỗi phát hiện khi review (xem mục 8): `gdrive_download` ghi file tuỳ ý kể cả ở readonly;
  Drive 403 `rateLimitExceeded` không được thử lại; không timeout; thứ tự slide pptx lấy theo tên
  file; `read-document.mjs` và `tools.mjs` không có test.

## Ràng buộc

- Danh tính vẫn là service account. Không thêm OAuth.
- Không thêm dependency.
- Mặc định không có quyền ghi: tool ghi chỉ xuất hiện khi có folder `write`.
- Vẫn chạy với mọi client đang hỗ trợ (Claude Code, Codex, Copilot, Cursor, Kiro) và với CLI,
  thư viện.
- Service account không có dung lượng My Drive. Mọi thao tác tạo file có thể bị giới hạn ở
  Shared Drive (xem mục Kiểm chứng).

## Ngoài phạm vi

- Upload, ghi đè nội dung file nhị phân, tải file qua MCP. CLI và thư viện vẫn giữ `get`, `put`.
- Xoá file, quản lý quyền share.
- Sửa nội dung Doc có sẵn.
- Tìm kiếm theo nội dung (`fullText`).

## 1. Phạm vi folder

### Cấu hình

File config hiện có (chmod 600) thêm khoá `folders`:

```json
{
  "clientEmail": "…",
  "privateKey": "…",
  "folders": [
    { "id": "1AbC…", "name": "bao-cao", "access": "read" },
    { "id": "1XyZ…", "name": "test-run", "access": "write" }
  ]
}
```

- `name` là duy nhất, chỉ gồm `[a-z0-9-]`, dùng làm tên gợi nhớ cho model.
- `access` là `read` hoặc `write`.
- Khoá `mode` cũ (`readonly`/`readwrite`) bị bỏ qua khi có `folders`. Không có `folders` thì
  coi như danh sách rỗng.

Biến môi trường cho CI, dùng thay khoá `folders` khi có:

```
GDRIVE_FOLDERS="test-run=1XyZ…:write,bao-cao=1AbC…:read"
```

### Lệnh CLI

```bash
gdrive folder add <url|id> [--name <tên>] [--access read|write]   # mặc định read
gdrive folder list
gdrive folder remove <tên>
gdrive folder set <tên> --access read|write
```

`folder add` gọi `files.get` để xác nhận service account thấy folder và đó đúng là folder.
Không thấy thì báo cần share cho email nào. Không truyền `--name` thì lấy tên folder trên
Drive, chuyển về dạng `[a-z0-9-]`. Trùng tên thì báo lỗi, không ghi đè.

### Quy tắc kiểm soát

Mô-đun mới `src/scope.mjs`, mọi tool đi qua nó trước khi gọi API nội dung.

- `resolveTarget(input)` nhận tên gợi nhớ, đường dẫn dạng `test-run/sub/file`, URL hoặc ID và
  trả về `{ fileId, root }`, trong đó `root` là folder trong danh sách chứa file.
- Một file thuộc phạm vi khi chính nó, hoặc một tổ tiên của nó theo `parents`, là một folder
  trong danh sách. Folder con ở mọi độ sâu đều thuộc phạm vi.
- Lần theo tổ tiên bằng `files.get(fields=id,name,mimeType,parents)`, có giới hạn độ sâu 32
  để tránh vòng lặp. Kết quả `fileId → root|null` được cache 10 phút. Cache bị xoá khi chính
  server tạo, đổi tên hay di chuyển file, và khi danh sách folder thay đổi.
- Không thuộc phạm vi: lỗi `ngoài phạm vi`, kể cả khi service account đọc được file.
- Lệnh ghi cần `root.access === 'write'`. `drive_move` cần cả folder nguồn và folder đích là
  `write`.
- Danh sách rỗng: mọi tool trả lỗi hướng dẫn chạy `gdrive folder add`.
- Tool ghi (`sheet_write`, `drive_create`, `drive_move`) chỉ có trong `tools/list` khi có ít nhất
  một folder `write`. Đổi danh sách folder thì server bắn `notifications/tools/list_changed`
  bằng cơ chế nạp lại cấu hình sẵn có.

## 2. Bộ tool MCP

Năm tool thay cho bảy tool cũ. Mô tả mỗi tool 1–2 câu tiếng Anh ngắn để tiết kiệm token (model
đọc tiếng Anh với ít token hơn tiếng Việt); thông báo lỗi và hướng dẫn cho người dùng vẫn bằng
tiếng Việt. Kết quả là văn bản thuần, không bọc JSON.

### `drive_ls` `{ path?, query?, limit? }`

- Không có `path`: liệt kê các folder trong danh sách kèm tên và quyền.
- Có `path`: liệt kê nội dung folder đó (một cấp). `query` lọc theo tên (`name contains`) trong
  folder đó. `limit` mặc định 30, tối đa 200.
- Định dạng:

```
# test-run (write) · 3/3
d 2026-Q3        1Abc
s TC_login       1Def 2026-09-30
x report.xlsx    1Ghi 2026-09-28 48KB
```

Mã loại: `d` folder, `s` Google Sheet, `c` Google Doc, `p` Google Slides, `x` xlsx, `w` docx,
`k` pptx, `t` text/csv/md, `f` khác. Có trang sau thì dòng đầu kèm `next=<token>`.

### `drive_read` `{ target, sheet?, columns?, where?, offset?, limit?, max_chars? }`

Tự nhận loại file.

- Google Sheet và xlsx: trả TSV. Dòng 1 của tab là header.
  - `columns`: danh sách tên cột cần lấy.
  - `where`: object `{ "<cột>": "<giá trị>" }`, so khớp chính xác sau khi trim, nhiều điều kiện
    là AND.
  - `offset`, `limit` (mặc định 200, tối đa 2000) tính trên các dòng sau khi lọc.
  - Dòng đầu kết quả:
    `# TC_login › Sheet1 · tabs: Sheet1,Data · rows 201-400/1834 · next=400`
  - Ô chứa tab hoặc xuống dòng được thay bằng dấu cách để giữ cấu trúc TSV.
- Google Doc, Slides, docx, pptx, txt, md, csv: markdown hoặc text, cắt theo `max_chars`
  (mặc định 20000). Bị cắt thì dòng cuối là `# truncated at <n>/<total> chars`.
- Loại khác: một dòng metadata và gợi ý dùng CLI `gdrive get`.

### `sheet_write` `{ target, sheet?, cells?, append? }`

- `cells`: `{ "L5": "PASS", "L6": "FAIL" }` ghi đè, gom vào một `values.batchUpdate`.
- `append`: mảng các dòng, một `values.append` với `insertDataOption=INSERT_ROWS`.
- Kết quả một dòng: `✓ Sheet1: 2 cells, +1 rows`.

### `drive_create` `{ parent, name, kind, content? }`

- `kind`: `folder`, `doc` hoặc `sheet`.
- `doc` nhận `content` markdown (upload `text/markdown`, Drive chuyển thành Google Doc).
- `sheet` nhận `content` CSV hoặc TSV (upload `text/csv`, Drive chuyển thành Google Sheet).
- Kết quả: `✓ <kind> <name> <id> <link>`.

### `drive_move` `{ target, new_name?, to? }`

Đổi tên (`files.update` name) và/hoặc chuyển folder (`addParents`/`removeParents`).

### Lỗi

Một dòng, bắt đầu bằng `✗`, có hướng xử lý. Ví dụ:

```
✗ ngoài phạm vi: file không thuộc folder nào được phép (bao-cao, test-run)
✗ chỉ đọc: folder bao-cao có quyền read
✗ 403: chưa share cho sa@proj.iam.gserviceaccount.com
✗ append chưa chắc đã ghi (timeout). Đọc lại cuối bảng trước khi thử lại.
```

### Ảnh hưởng tới phần còn lại

- `src/tools.mjs` viết lại theo bộ tool mới. `src/instructions.mjs` rút gọn theo.
- `skills/gdrive/SKILL.md` và skill cài qua `--skill` cập nhật tên tool.
- CLI giữ các lệnh hiện có, thêm nhóm `folder`. Lệnh `read`, `doc`, `ls`, `write` dùng cùng lớp
  phạm vi khi có danh sách folder; script dùng thư viện (`createClient`) không bị giới hạn.

## 3. Hiệu năng và độ ổn định

Sửa trong `src/http.mjs` và `src/client.mjs`.

- Timeout mỗi request bằng `AbortSignal.timeout`: 30 giây cho API, 120 giây cho tải nội dung
  file.
- Thử lại tối đa 4 lần với backoff mũ có jitter (cơ sở 500ms, trần 16 giây), ưu tiên giá trị
  `Retry-After` khi có, cho:
  - 408, 429, 500, 502, 503, 504, lỗi mạng, timeout;
  - 403 có `reason` là `rateLimitExceeded` hoặc `userRateLimitExceeded`.
- 401: xoá token trong cache, lấy token mới, thử lại đúng một lần.
- Request không idempotent (`values.append`, `files.create`) chỉ thử lại khi Google chắc chắn
  đã từ chối: 429, 403 giới hạn tốc độ, 503. Timeout hoặc lỗi mạng thì trả lỗi "chưa chắc đã
  ghi".
- Cache trong tiến trình server:
  - metadata Drive (`files.get`: tên, mimeType, parents, size) và metadata Sheets
    (`spreadsheets.get`: tab, gid, kích thước) 5 phút, xoá khi chính server ghi vào file đó;
  - phạm vi file như mục 1.
  Nhờ vậy lần đọc lặp lại một sheet chỉ còn 1 request thay vì 3. Mục tiêu đo được: `drive_read`
  lần hai trên cùng file dưới 700 ms (hiện 1.300–1.500 ms).
- Giới hạn 4 request đồng thời tới Google trong một tiến trình.
- Chỉ xin `fields` cần thiết cho mỗi lệnh.
- `GDRIVE_DEBUG=1`: ghi ra stderr mỗi request một dòng gồm method, đường dẫn (không có query
  chứa dữ liệu), status, thời gian, số lần thử, kích thước response.
- Giới hạn kích thước file tải về để đọc: từ chối file có `size` trên 50 MB với lỗi gợi ý dùng
  CLI `gdrive get`. `inflateRawSync` trong `zip.mjs` đặt `maxOutputLength` 256 MB để chặn zip
  bomb.
- `writeConfig` ghi file tạm cùng thư mục với `mode: 0o600` rồi `rename`, để server đang chạy
  không bao giờ đọc được file dở và rơi xuống config cũ.
- Test `test/http.test.mjs` hiện khoá hành vi "403 không thử lại"; test này được viết lại theo
  quy tắc mới (403 giới hạn tốc độ thì thử lại, 403 thiếu quyền thì không).

### Sửa lỗi ngoài phạm vi tính năng, làm cùng đợt

- **Bảo mật:** `gdrive_download` và `gdrive_upload` bỏ khỏi MCP (đã quyết ở mục 2). CLI `get`
  giữ nguyên vì người dùng gõ tay. Không còn đường nào để model ghi hoặc đọc file tuỳ ý trên
  máy qua MCP.
- **Thứ tự slide:** `ooxml-pptx.mjs` đọc `ppt/presentation.xml` (`sldIdLst`) và
  `ppt/_rels/presentation.xml.rels` để xếp slide; ghép notes qua `slides/_rels/slideN.xml.rels`.
  Thiếu các part này thì mới rơi về thứ tự theo tên file, kèm warning.
- **docx `format: text`:** bỏ regex xoá dòng bắt đầu bằng `-` ở `ooxml-docx.mjs`, vì nó xoá cả
  hàng bảng có số âm; thay bằng xoá đúng dòng phân cách `|---|`.
- **xlsx:** `attrs['r:id']` đổi sang tìm thuộc tính theo local name `id` trong namespace
  relationships, cùng cách `nsTag` đang làm.
- **Public API:** `createClient()` không trả `credentials` chứa `privateKey`; chỉ trả
  `{ clientEmail, type, source }`.
- Trùng lặp nhỏ: `nodeOk` dùng chung giữa `server/index.mjs` và `status.mjs`; map MIME export
  dùng `formats.mjs`.

## 4. Kiểm chứng trước khi code phần ghi

Người dùng tạo một folder thử trong My Drive, share Editor cho service account. Nếu có, thêm
một folder trong Shared Drive. Chạy thử bằng script tạm, ghi lại kết quả vào spec này:

| Thao tác | My Drive | Shared Drive |
|---|---|---|
| Tạo folder con | ? | ? |
| Tạo Google Doc từ markdown | ? | ? |
| Tạo Google Sheet từ CSV | ? | ? |
| Đổi tên file của người dùng | ? | ? |
| Di chuyển file giữa hai folder được share | ? | ? |
| `values.append`, `values.batchUpdate` | ? | ? |

Thao tác nào thất bại ở My Drive thì tool trả lỗi giải thích cần Shared Drive, và README ghi
rõ trong mục giới hạn. Không có thao tác nào bị bỏ khỏi thiết kế chỉ vì My Drive không hỗ trợ.

## 5. Kiểm thử

Tất cả chạy bằng `node --test`, không cần mạng, trên Linux, macOS, Windows với Node 18 và 22.

- `test/scope.test.mjs`: file trong folder con được đọc; file ngoài phạm vi bị từ chối; ghi
  vào folder `read` bị từ chối; danh sách rỗng chặn hết; `drive_move` sang folder ngoài phạm
  vi bị từ chối; vòng `parents` không treo; cache trúng và bị xoá đúng lúc; `GDRIVE_FOLDERS`.
- `test/format.test.mjs`: TSV, dòng tiêu đề, `columns`, `where`, phân trang, ô có tab và xuống
  dòng, cắt văn bản.
- `test/http.test.mjs` (mở rộng): timeout; `Retry-After`; 403 giới hạn tốc độ được thử lại,
  403 thiếu quyền thì không; 401 lấy token mới; `append` không thử lại khi timeout; giới hạn
  đồng thời.
- `test/mcp-server.test.mjs` và `test/clients.test.mjs`: cập nhật tên tool, kiểm tra tool ghi
  chỉ hiện khi có folder `write`; thêm ca một tool call sau khi reload config dùng đúng credential
  mới.
- `test/tools.test.mjs` (mới): chạy `run()` của cả 5 tool với client giả (fetch giả trả fixture),
  kiểm định dạng kết quả, lỗi `✗`, và không tool nào đụng tới hệ thống file.
- `test/read-document.test.mjs` (mới): `max_chars` cắt đúng và không còn trường thừa, cảnh báo
  khi `range` dùng với xlsx, phân loại file.
- `test/ooxml-pptx.test.mjs`: thứ tự slide theo `sldIdLst` khác thứ tự tên file; notes qua rels.
- `test/ooxml-docx.test.mjs`: bảng có số âm ở cột đầu còn nguyên trong `format: text`.
- `test/ooxml-xlsx.test.mjs`: rels với tiền tố namespace khác `r:`.
- `test/install.test.mjs`: `writeConfig` không để lại file tạm, file cuối có mode 600 ngay từ
  đầu.
- `test/folder-cli.test.mjs`: `folder add/list/remove/set` trên HOME tạm với Drive giả.

## 6. Đo token

- `bench/tokens.mjs` tính kích thước schema các tool và kết quả của `drive_ls`, `drive_read`
  trên dữ liệu mẫu cố định trong `test/fixtures/`.
- Không có tokenizer trong repo (không dependency), nên script ước lượng bằng
  `ceil(bytes / 3.5)` cho văn bản tiếng Anh và in kèm số byte.
- CI chạy script và báo đỏ khi schema vượt 700 token ước lượng.
- Con số so với connector trong README là phép đo thật bằng `tiktoken` (`o200k_base`) ghi kèm
  ngày đo, phương pháp, và lệnh để tự đo lại.

## 7. README và phát hành

README viết lại cho người mới, theo thứ tự: gdrive-cli là gì; mô hình phạm vi folder; bảng
token so với connector; cơ chế ổn định; cài đặt 3 bước (`npm i -g`, `gdrive init`,
`gdrive folder add`) cộng `install --client`; năm tool; giới hạn của service account (kèm kết
quả mục 4); nâng cấp từ v0.3. Văn bản rà bằng skill humanizer.

Phát hành v0.4.0, ghi trong CHANGELOG là thay đổi phá tương thích:

- Phải chạy `gdrive folder add` sau khi nâng cấp, nếu không mọi tool từ chối truy cập.
- Tên tool đổi: `gdrive_sheet_read`, `gdrive_read_document`, `gdrive_file_info` gộp thành
  `drive_read`; `gdrive_list` thành `drive_ls`; `gdrive_sheet_write` thành `sheet_write`;
  `gdrive_download`, `gdrive_upload` bỏ khỏi MCP.
- Người đã chạy `gdrive install --client` không phải chạy lại: entry MCP giữ nguyên.

## 8. Nguồn các phát hiện

Review code ngày 2026-10-01 bởi hai lượt đọc độc lập toàn bộ `src/`, `server/`, `bin/`, `test/`,
cùng đo hiệu năng và token trên Drive thật. Các lỗi mức High đã được xác minh lại trong code
trước khi đưa vào spec này. Các mục Low (phân trang `list`, `protocolVersion` echo, `readJson`
nuốt lỗi, `sheets-compat` lặp URL) ghi nhận nhưng không nằm trong v0.4.0.
