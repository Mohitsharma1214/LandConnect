import { Files } from "files-sdk";
import { neon } from "files-sdk/neon";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

if (!process.env.AWS_ENDPOINT_URL && process.env.AWS_ENDPOINT_URL_S3) {
  process.env.AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL_S3;
}

async function main() {
  const bucketName = "uploads";
  console.log(`Connecting to Neon Object Storage bucket: "${bucketName}"...`);
  
  const files = new Files({ adapter: neon({ bucket: bucketName }) });

  const testFileName = "test-verification.txt";
  const testContent = "LandConnect Verified: Neon Object Storage is connected and functioning perfectly!";

  console.log(`\n1. Uploading test file: "${testFileName}"...`);
  await files.upload(testFileName, testContent, { contentType: "text/plain" });
  console.log(`Uploaded successfully.`);

  console.log(`\n2. Listing files in bucket "${bucketName}"...`);
  const listResult = await files.list();
  console.log("Bucket contents:", JSON.stringify(listResult, null, 2));

  console.log(`\n3. Reading file back from bucket...`);
  const downloadedFile = await files.download(testFileName);
  const downloadedText = await downloadedFile.text();
  console.log("Retrieved File Content:");
  console.log("-----------------------------------------");
  console.log(downloadedText);
  console.log("-----------------------------------------");

  console.log("\nNeon Object Storage test PASSED successfully!");
}

main().catch((err) => {
  console.error("Storage test error:", err);
  process.exit(1);
});
