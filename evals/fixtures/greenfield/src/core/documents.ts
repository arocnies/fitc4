// Reads and writes order documents in object storage. The planted ground
// truth: the model declares TWO object-storage elements (live storage and the
// cold archive) and nothing here says which bucket this client touches, so the
// only correct `agentResolve` behavior is abstention — the candidate stays
// unmapped rather than being guessed at.
import { S3Client } from '@aws-sdk/client-s3'

export function documentClient(): S3Client {
  return new S3Client({})
}
