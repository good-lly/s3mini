import assert from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { S3mini } from '../dist/s3mini.js';

describe("Minio", async () => {
    const s3 = new S3mini({
        accessKeyId: "AAA",
        secretAccessKey: "BBBBBBBB",
        endpoint: "http://127.0.0.1:9090/bucket"
    });

    const bucket = await s3.bucketExists() || await s3.createBucket();
    assert.strictEqual(bucket, true);

    it("Should accept valid x-amz-checksum-sha1", async () => {
        const fileContents = Buffer.from("Some file contents.", "utf-8");
        const hasher = createHash("sha1");
        hasher.setEncoding("base64");
        hasher.write(fileContents);
        hasher.end();
        const fileHash = hasher.read();

        const result = await s3.putObject("private.txt", fileContents, "text/plain", undefined, {
            "x-amz-acl": "private",
            "x-amz-checksum-sha1": fileHash,
        });

        assert.ok(result.ok);
        assert.strictEqual(result.headers.get("x-amz-checksum-sha1"), fileHash);
    });

    it("Should error on invalid x-amz-checksum-sha1", async () => {
        const fileContents = Buffer.from("Some file contents.", "utf-8");
        const hasher = createHash("sha1");
        hasher.setEncoding("base64");
        hasher.write(fileContents);
        hasher.write("Make the hash faulty.");
        hasher.end();
        const fileHash = hasher.read();

        const result = s3.putObject("private.txt", fileContents, "text/plain", undefined, {
            "x-amz-acl": "private",
            "x-amz-checksum-sha1": fileHash,
        });

        await assert.rejects(result, (error: any) => {
            assert.ok("body" in error);
            assert.match(error.body, /Value for x-amz-checksum-sha1 header is invalid./);
            return true;
        });
    });
});