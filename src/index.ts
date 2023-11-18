#!/usr/bin/env node

import { program } from "commander";
import { ListObjectsCommand, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { promises as fs } from "fs";
import * as path from "path";
import * as ejs from "ejs";

const packageJSON = require("../package.json");

program
	.name(packageJSON.name)
	.version(packageJSON.version)
	.description(packageJSON.description);

program
	.option("--bucket <bucket>", "AWS Bucket", process.env.AWS_BUCKET ?? "")
	.option("--region <region>", "AWS Region", process.env.AWS_REGION ?? "")
	.option("--access-key-id <accessKeyId>", "AWS Access Key ID", process.env.AWS_ACCESS_KEY_ID ?? "")
	.option("--secret-access-key <secretAccessKey>", "AWS Secret Access Key", process.env.AWS_SECRET_ACCESS_KEY ?? "")
	.option("--footer <footer>", "Footer text", "")
	.option("-o --output <path>", "Output path", ".")
	.option("-v --verbose", "Verbose output")
	.option("--endpoint <endpoint>", "S3 Endpoint (if using a custom endpoint)")
	.option("--forcePathStyle", "Force path style", false);

program.parse(process.argv);

const options = program.opts();

(async () => {
	options.verbose && console.log("Verbose output enabled.");

	if (options.endpoint && !options.forcePathStyle) {
		options.forcePathStyle = true;
		options.verbose && console.log("Forcing Path Style since endpoint is specified.");
	}

	let s3ClientOptions: S3ClientConfig = {
		"forcePathStyle": options.forcePathStyle,
		"credentials": {
			"accessKeyId": options.accessKeyId,
			"secretAccessKey": options.secretAccessKey,
			"sessionToken": process.env.AWS_SESSION_TOKEN
		}
	};
	if (process.env.AWS_CREDENTIAL_EXPIRATION && s3ClientOptions.credentials) {
		(s3ClientOptions.credentials as any).expiration = new Date(process.env.AWS_CREDENTIAL_EXPIRATION);
	}
	if (options.endpoint) {
		s3ClientOptions.endpoint = options.endpoint;
	}
	const s3Client = new S3Client(s3ClientOptions);

	if (!options.bucket) {
		console.error("Bucket not set. Please set the AWS_BUCKET environment variable or use the --bucket option.");
		process.exit(1);
	}

	let command = new ListObjectsCommand({
		"Bucket": options.bucket,
		"MaxKeys": 1000
	});

	let response, allObjects = [];
	do {
		response = await s3Client.send(command);
		allObjects.push(...response.Contents ?? []);
		command = new ListObjectsCommand({
			"Bucket": options.bucket,
			"MaxKeys": 100,
			"Marker": response.NextMarker
		});
	} while (response.NextMarker);

	const result = allObjects.map((object, _i, array) => {
		const keyParts = (object.Key?.split("/") ?? []).filter((part) => part.length > 0);
		const levelsDeep = keyParts.length;
		const isFolder = array.some((otherObject) => otherObject.Key?.startsWith(object.Key ?? "") && otherObject.Key !== object.Key);
		const isFile = !isFolder;
		const parentKey = keyParts.slice(0, -1).join("/");

		return {
			...object,
			"KeyParts": keyParts,
			"LevelsDeep": levelsDeep,
			"IsFolder": isFolder,
			"IsFile": isFile,
			"ParentKey": parentKey,
			"FileName": keyParts[keyParts.length - 1],
			"URL": (() => {
				if (isFolder) {
					return `/${keyParts.join("/")}`;
				} else if (options.endpoint) {
					return `${options.endpoint}/${keyParts.join("/")}`;
				} else {
					return `https://${options.forcePathStyle ? "" : `${options.bucket}.`}s3-${options.region}.amazonaws.com${options.forcePathStyle ? `/${options.bucket}` : ""}/${keyParts.join("/")}`;
				}
			})()
		};
	}).reduce((returnObject, object) => {
		const returnObjectKey = object.ParentKey ?? "/";
		const itemsArray = returnObject[returnObjectKey] ?? [];
		itemsArray.push(object);
		returnObject[returnObjectKey] = itemsArray;

		return returnObject
	}, { "/": [] } as any);

	await Promise.all(Object.entries(result).map(async ([key, value]) => {
		const file = await ejs.renderFile(path.join(__dirname, "..", "templates", "main.ejs"), {
			"title": `${options.bucket} - ${key}`,
			"items": value,
			options
		});

		const saveLocation = path.join(options.output, key);
		await fs.mkdir(saveLocation, {
			"recursive": true
		});
		await fs.writeFile(path.join(saveLocation, "index.html"), file);
	}));

	// Copy public folder to output
	copyDir(path.join(__dirname, "..", "public"), path.join(options.output, "public"));
})();

async function copyDir(src: string, dest: string) {
	await fs.mkdir(dest, {
		"recursive": true
	});

	const entries = await fs.readdir(src, {
		"withFileTypes": true
	});

	await Promise.all(entries.map(async (entry) => {
		let srcPath = path.join(src, entry.name);
		let destPath = path.join(dest, entry.name);

		entry.isDirectory() ? await copyDir(srcPath, destPath) : await fs.copyFile(srcPath, destPath);
	}));
}
