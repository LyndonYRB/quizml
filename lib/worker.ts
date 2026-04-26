import { Worker } from "bullmq";
import { processStudyMaterialIngestionJob } from "./ingestion-processor";
import {
  getQueueConnection,
  STUDY_MATERIAL_INGESTION_QUEUE_NAME,
} from "./queue";

const studyMaterialIngestionWorker = new Worker(
  STUDY_MATERIAL_INGESTION_QUEUE_NAME,
  async (job) => {
    await processStudyMaterialIngestionJob(job.data);
  },
  {
    connection: getQueueConnection(),
    concurrency: 1,
  }
);

studyMaterialIngestionWorker.on("ready", () => {
  console.log("study material ingestion worker ready");
});

studyMaterialIngestionWorker.on("completed", (job) => {
  console.log("study material ingestion job completed:", job.id);
});

studyMaterialIngestionWorker.on("failed", (job, error) => {
  console.error("study material ingestion job failed:", {
    jobId: job?.id,
    message: error.message,
  });
});

process.on("SIGINT", async () => {
  await studyMaterialIngestionWorker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await studyMaterialIngestionWorker.close();
  process.exit(0);
});

export { studyMaterialIngestionWorker };
