import IORedis from "ioredis";
import { Queue } from "bullmq";
import type { StudyMaterialIngestionJobPayload } from "./ingestion-processor";

export const STUDY_MATERIAL_INGESTION_QUEUE_NAME = "study-material-ingestions";

let redisConnection: IORedis | null = null;
let studyMaterialIngestionQueue:
  | Queue<StudyMaterialIngestionJobPayload>
  | null = null;

function getRedisUrl() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("Missing REDIS_URL environment variable.");
  }

  return redisUrl;
}

export function getQueueConnection() {
  if (!redisConnection) {
    redisConnection = new IORedis(getRedisUrl(), {
      maxRetriesPerRequest: null,
    });
  }

  return redisConnection;
}

export function getStudyMaterialIngestionQueue() {
  if (!studyMaterialIngestionQueue) {
    studyMaterialIngestionQueue = new Queue<StudyMaterialIngestionJobPayload>(
      STUDY_MATERIAL_INGESTION_QUEUE_NAME,
      {
        connection: getQueueConnection(),
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      }
    );
  }

  return studyMaterialIngestionQueue;
}
