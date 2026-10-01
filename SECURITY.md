# Chính sách bảo mật

gdrive-cli lưu private key của service account trên máy người dùng và gọi Google API bằng key
đó. Lỗi bảo mật ở đây có thể làm lộ key hoặc cho AI truy cập nhiều hơn mức người dùng cho phép,
nên xin báo riêng, đừng mở issue công khai.

## Phiên bản được hỗ trợ

Chỉ bản mới nhất trên nhánh `main` được sửa lỗi bảo mật.

| Phiên bản | Hỗ trợ |
|---|---|
| 0.3.x | Có |
| < 0.3 | Không |

## Cách báo lỗ hổng

Dùng tính năng báo lỗ hổng riêng của GitHub:
[Report a vulnerability](https://github.com/sdc-ren/gdrive-cli/security/advisories/new).
Chỉ maintainer đọc được báo cáo.

Nên có trong báo cáo:

- Phiên bản (`gdrive --version`), hệ điều hành, phiên bản Node.
- Client AI đang dùng (Claude Code, Codex, Cursor…) nếu liên quan.
- Các bước tái hiện, và điều xảy ra khác với điều bạn mong đợi.

Không gửi kèm file key thật hay dữ liệu thật trên Drive. Dùng service account và file thử.

Maintainer sẽ phản hồi trong vòng 7 ngày, xác nhận lỗi, và báo thời điểm dự kiến có bản sửa.
Sau khi bản sửa được phát hành, lỗ hổng được công bố qua GitHub Security Advisory, có ghi công
người báo nếu bạn muốn.

## Phạm vi

Những thứ được tính là lỗ hổng:

- Private key bị ghi ra ngoài file config (chmod 600), bị in ra log, stdout, kết quả tool, hoặc
  bị ghi vào config của client AI.
- Chế độ readonly bị vượt qua: tool ghi xuất hiện hoặc gọi được khi chưa bật `readwrite`.
- Lệnh `install`, `uninstall` hoặc `init` ghi, sửa, xoá file nằm ngoài những file được mô tả
  trong README.
- Dùng nhầm danh tính: chạy bằng ADC hoặc gcloud của người dùng khi họ chưa bật `--adc`.

Ngoài phạm vi:

- Người dùng tự share file cho service account hoặc tự bật `readwrite`.
- Lỗi của Google API, của client AI, hoặc của model.
- Máy đã bị chiếm quyền, nơi kẻ tấn công đọc được file chmod 600 của bạn.

## Nếu key của bạn bị lộ

Xoá file config không thu hồi được key. Vào GCP Console, mở service account, vào tab Keys, xoá
key bị lộ rồi tạo key mới, sau đó chạy lại `gdrive init --sa-json <file-mới>`. `gdrive uninstall
--purge` xoá mọi file config chứa key trên máy.
