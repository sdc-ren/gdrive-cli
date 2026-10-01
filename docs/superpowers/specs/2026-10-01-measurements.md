# Số đo thật 2026-10-01 (tiktoken o200k_base; độ trễ qua MCP server thật, Drive của người dùng)

## Token
| Mục | v0.3 (cũ) | v0.4 (mới) | Connector Google Drive của Claude |
|---|---|---|---|
| Schema tool, chế độ đọc | 764 (5 tool) + 305 instructions | 265 (2 tool) + 196 instructions | 2.337 (6 tool đọc) |
| Schema tool, đủ quyền ghi | 1.142 (7 tool) | 561 (5 tool) | 3.610 (11 tool) |
| Đọc cả tab Google Sheet (25 dòng × 6 cột, tiếng Việt) | 7.334 | 6.090 | chưa đo trực tiếp |
| Đọc 10 dòng đầu (limit=10) | không có | 2.599 | không có tuỳ chọn |
| Đọc xlsx (1 tab, 23 dòng) | 3.080 | 2.261 | ≈2.829 (ước từ output thật) |
| Đọc docx ~10k ký tự | 3.837 | 3.604 | ≈3.650 (ước) |
| Liệt kê 10 file | 1.401 | 957 | chưa đo; mặc định kèm snippet tới 5.000 ký tự/file |

## Độ trễ (ms), server đã khởi động
| Thao tác | v0.3 | v0.4 |
|---|---|---|
| Đọc sheet lần đầu (lấy token + metadata) | 2.557 | 2.278 |
| Đọc sheet lặp lại | 1.300–1.500 | 359–390 |
| Đọc 10 dòng của sheet | 1.445 | 499 |
| Đọc xlsx lần 2 | 1.500 | 761 |
| Đọc docx | 1.750–2.360 | 2.138–2.292 (export mỗi lần, không cache nội dung) |
| ls 10 file | 764 | 1.135 (gồm 1 lần files.get kiểm phạm vi) |
| 5 call song song (10 dòng) | 1.431 | 887 |
| Khởi động → initialize | 47 | ~45 |

Ghi chú: tokenizer của Claude cho số khác tiktoken; tỷ lệ giữa các cột giữ nguyên. Connector không lộ thời gian nên không so độ trễ.
