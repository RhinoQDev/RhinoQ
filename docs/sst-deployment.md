# SST deployment adapter

RhinoQ's SST adapter translates one canonical RhinoQ plan into deterministic
SST resource intent. It does not select an AWS account, VPC, cluster, database,
container image, IAM policy or secret value. Those remain owned by the
application's `sst.config.ts` composition root.

```ts
import {
  compileRhinoQSSTDeployment,
  materializeRhinoQSSTDeployment,
} from '@rhinoq/node/sst';

const spec = compileRhinoQSSTDeployment({
  plan: rhinoq.plan(),
  worker: {
    image: imageUri,
    command: ['./rhinoq-worker'],
    cpu: '2 vCPU',
    memory: '4 GB',
  },
  migration: {
    command: ['./rhinoq', 'migrate', 'apply'],
  },
  workbench: true,
});

const deployed = materializeRhinoQSSTDeployment({
  spec,
  links: {
    'storage:artifacts': artifactsBucket,
  },
  materializer: {
    migration: (name, args) => new MyMigrationTask(name, args),
    service: (name, args) => new sst.aws.Service(name, {
      cluster,
      image: args.image,
      command: args.command,
      environment: args.environment,
      link: args.links,
      // Translate cpu/memory through the adopter's selected SST component.
    }),
  },
});
```

The explicit materializer boundary prevents the Node SDK from depending on one
SST release or guessing how an adopter builds images. Compilation performs no
cloud action. Materialization refuses a missing capability resource and passes
only public environment metadata: application, stage, namespace, plan
fingerprint and the registered handler list. Credentials are provided through
the linked SST resources or application-owned secret configuration.

The migration and service factories declare infrastructure only. Go,
Application and PostgreSQL remain authoritative for migrations, Task state,
leases, fencing, retry and Effect Ledger decisions at runtime.
