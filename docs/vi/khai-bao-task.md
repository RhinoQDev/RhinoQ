# Khai báo một Task, dùng ở producer và worker

Task là một công việc chạy nền có ID, owner, trạng thái, progress và lịch sử
thực thi. Với Application Compiler, adapter/runtime/scope được khai báo một lần:

```ts
const rhinoq = defineRhinoQApplication({
  profile: { name: 'reports', adapters: [bullmqAdapter] },
  tasks: (task) => ({
    exportReport: task({
      name: 'report.export',
      retry: { mode: 'runtime', maxAttempts: 3 },
      run: async ({ reportId }, context) => {
        await context.progress(0, 1, 'Đang tạo báo cáo');
        return generateReport(reportId);
      },
    }),
  }),
});
```

Khởi động một lần:

```ts
const app = await rhinoq.start({
  pool,
  ownerFromNodeRequest,
  http: { operatorToken: process.env.RHINOQ_OPERATOR_TOKEN! },
});
```

Dispatch ở producer:

```ts
await app.tasks.exportReport.dispatch({
  id: 'report-42',
  ownerId: user.id,
  payload: { reportId: '42' },
});
```

Worker dùng `app.workerHandler()` hoặc `app.runWorker()`. RhinoQ từ chối tên
Task chưa đăng ký, tự nối trạng thái/progress/API/UI nhưng runtime được chọn vẫn
sở hữu lease và retry execution.

## Mặc định an toàn

- Retry mặc định là `never`.
- Muốn retry phải đặt `maxAttempts` hữu hạn.
- Email, thanh toán, webhook hoặc tác động bên ngoài phải khai báo idempotency
  và confirmation policy.
- Không biết provider đã thực hiện hay chưa thì không retry mù.

File đầu ra được trả bằng `context.output.*`; đọc
[File và artifact](./tep-va-artifact.md).
