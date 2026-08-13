# File, video lớn, nhiều file và ZIP

## Luồng hoàn chỉnh

```text
Task handler → stream/multipart → private cloud storage
            → SHA-256 + metadata PostgreSQL
            → owner API → signed URL → Task Center
```

Reference private không được trả về browser. Khi người dùng bấm tải, API kiểm
tra owner/tenant rồi mới tạo URL ngắn hạn.

## Cấu hình S3 ngắn nhất

```ts
const app = await createRhinoQApp({
  pool, adapters, ownerFromNodeRequest,
  artifacts: 's3',
});
```

```env
RHINOQ_ARTIFACT_BUCKET=my-private-files
RHINOQ_ARTIFACT_REGION=ap-southeast-1
RHINOQ_ARTIFACT_MAX_BYTES=10737418240
RHINOQ_ARTIFACT_CONTENT_TYPES=video/mp4,application/pdf,application/zip
```

Cài thêm các package tùy chọn:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

R2, MinIO và Spaces dùng cùng factory; thêm endpoint/credential theo chuẩn AWS
SDK. Secret chỉ tồn tại ở server.

## File thông thường

```ts
return context.output.pdf('/work/report.pdf');
return context.output.video('/work/output.mp4');
return context.output.archive('/work/export.zip');
```

RhinoQ tự suy ra tên/MIME, đọc theo stream, tính checksum, cập nhật progress,
upload multipart, đăng ký metadata và nối nút tải trên Task Center.

## Nhiều file riêng

```ts
return context.output.files(paths, {
  maxItems: 100,
  concurrency: 4,
});
```

Mỗi file là một artifact tải riêng. Giới hạn tối đa là 100 để khớp owner API
và Task Center. Concurrency hợp lệ từ 1 đến 16.

## Gộp nhiều file thành ZIP

```bash
npm install archiver
```

```ts
return context.output.zip(paths, {
  name: 'all-results.zip',
  maxItems: 500,
});
```

ZIP được tạo và upload theo stream, không giữ toàn bộ dữ liệu trong RAM. Mặc
định tối đa 100 input, cho phép tăng tới 1.000 vì kết quả chỉ là một artifact.
Tên file trùng nhau bị từ chối.

## Video vài GB và input từ browser

Không đưa bytes vào BullMQ/PostgreSQL. Browser upload multipart/resumable trực
tiếp vào private storage, sau đó dispatch Task với `sourceKey`. Worker đọc
`sourceKey`, xử lý video và trả output bằng `context.output.video()` hoặc
`context.artifact.stream()`.

## Phần ứng dụng vẫn phải quyết định

- bucket policy và credential;
- MIME/dung lượng được phép;
- business retry của transcode/upload;
- retention và xóa object;
- provider readback để xác nhận kết quả quan trọng.

Xem contract đầy đủ bằng tiếng Anh tại [artifact-storage.md](../artifact-storage.md).

## Upload trực tiếp file vài GB và resume

Với AWS S3, dùng `uploadArtifactFile` từ `@rhinoq/node/browser`. File đi thẳng
từ trình duyệt lên S3, không qua RAM server Node. RhinoQ tự tạo phiên multipart,
ký URL từng part, ghi ETag, đối chiếu part ở S3 khi resume và xác minh object
trước khi báo hoàn tất.

```ts
await uploadArtifactFile(taskClient, file, {
  taskId,
  checksumSha256, // bắt buộc khi gắn vào Task
  concurrency: 4,
  onProgress: ({ uploadedBytes, totalBytes }) => capNhat(uploadedBytes, totalBytes),
});
```

Lưu ID phiên và truyền lại bằng `sessionId` để resume. RhinoQ kiểm tra owner,
tenant và quyền sở hữu Task. Nếu kết quả complete không chắc chắn, trạng thái là
`uncertain`, không báo thành công và không retry mù. Gọi resume rồi complete lại
để chỉ xác minh readback, không gửi multipart complete lần hai. Phiên upload
mặc định 24 giờ; artifact mặc định 7 ngày.

## Xóa file hết hạn và xử lý video

Xem trước bằng `app.artifactRetention.preview(25)`, rồi mới chủ động gọi
`sweep({ delete: true })`. RhinoQ xóa object trước metadata; lỗi provider được
giữ lại để kiểm tra. Khi worker đã cài FFmpeg, dùng
`context.media.transcode()` hoặc `context.media.thumbnail()`. RhinoQ lo timeout,
cancel, kiểm tra output và đăng ký artifact; ứng dụng vẫn chọn codec, retention
và business retry.
