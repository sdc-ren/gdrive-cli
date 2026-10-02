# Số đo token và độ trễ

Các số dưới đây đo trên Google Drive thật. Token đếm bằng tiktoken `o200k_base`. Tokenizer của
Claude cho số khác, nhưng tỷ lệ giữa các cột vẫn giữ.

Tự đo ước lượng (theo số byte, không cần tokenizer):

```bash
npm run bench
```

CI báo đỏ khi tổng schema tool vượt 700 token ước lượng.

## Token

So sánh với v0.3 và connector Google Drive có sẵn trong Claude. Số của connector ở các dòng đọc
file được ước từ output thật của nó.

| Mục | v0.3 | v0.5 | Connector Google Drive của Claude |
|---|---|---|---|
| Schema tool, chỉ đọc | 764 (5 tool) + 305 instructions | 265 (2 tool) + 195 instructions | 2.337 (6 tool đọc) |
| Schema tool, có quyền ghi | 1.142 (7 tool) | 557 (5 tool) | 3.610 (11 tool) |
| Đọc cả tab Google Sheet (25 dòng × 6 cột, tiếng Việt) | 7.334 | 6.090 | chưa đo |
| Đọc 10 dòng đầu (`limit: 10`) | không có | 2.599 | không có tuỳ chọn này |
| Đọc xlsx (1 tab, 23 dòng) | 3.080 | 2.261 | khoảng 2.829 |
| Đọc docx khoảng 10.000 ký tự | 3.837 | 3.604 | khoảng 3.650 |
| Liệt kê 10 file | 1.401 | 957 | chưa đo; mặc định kèm snippet tới 5.000 ký tự mỗi file |

Schema v0.5 đo ngày 2026-10-02. Các dòng đọc file đo ngày 2026-10-01 trên v0.4; định dạng output
của v0.5 không đổi.

Schema được gửi kèm mọi lượt hội thoại nên là phần tiết kiệm lớn nhất. Với sheet lớn, `columns`,
`where` và `limit` cho model chỉ lấy phần cần đọc.

## Độ trễ

Đo ngày 2026-10-01 qua MCP server thật (server đã khởi động), đơn vị mili giây.

| Thao tác | v0.3 | v0.4 |
|---|---|---|
| Đọc sheet lần đầu (lấy token và metadata) | 2.557 | 2.278 |
| Đọc lại cùng sheet | 1.300-1.500 | 359-390 |
| Đọc 10 dòng của sheet | 1.445 | 499 |
| Đọc xlsx lần thứ hai | 1.500 | 761 |
| Đọc docx | 1.750-2.360 | 2.138-2.292 |
| Liệt kê 10 file | 764 | 1.135 |
| 5 lần đọc song song (10 dòng mỗi lần) | 1.431 | 887 |
| Khởi động tới `initialize` | 47 | khoảng 45 |

Docx được export lại mỗi lần đọc vì nội dung file không được cache. Ở v0.4, việc liệt kê chậm hơn
v0.3 vì phải lần theo folder cha để kiểm phạm vi. v0.5 bỏ bước này: mở một link tốn 1 request
metadata (cache 5 phút) và 1 request nội dung.

## Thao tác ghi của service account

Thử ngày 2026-10-01 trên một folder My Drive đã share quyền Editor cho service account:

| Thao tác | Kết quả |
|---|---|
| Tạo folder con | Chạy (folder không tốn dung lượng) |
| Tạo Google Doc từ markdown | Lỗi 403 `storageQuotaExceeded` |
| Tạo Google Sheet từ CSV | Lỗi 403 `storageQuotaExceeded` |
| Đổi tên file | Chạy |
| Chuyển file giữa hai folder được share | Chạy |

Service account không có dung lượng My Drive. Vì vậy `drive_create` với `kind: doc` hoặc `sheet`
kiểm tra folder đích trước khi gọi API: folder nằm trên My Drive thì tool trả lỗi giải thích cần
Shared Drive.

## Độ chính xác của bộ đọc xlsx

Bộ đọc `.xlsx` được đối chiếu với `python3` + `openpyxl` trên 6 file thật tải từ Drive: 3.859 ô,
không lệch ô nào.
