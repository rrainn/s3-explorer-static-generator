#!/usr/bin/env node

import { program } from "commander";
import { ListObjectsCommand, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { promises as fs } from "fs";
import * as path from "path";
import * as ejs from "ejs";
import { XMLBuilder } from "fast-xml-parser";

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
	.option("--include-hidden-files", "Include hidden files", false)
	.option("--include-sitemap", "Include sitemap", false)
	.option("--domain <domain>", "Domain name that this site will be hosted on", "")
	.option("--root-path <rootPath>", "Path to the root file (used if will be hosted in a subdirectory of a website)", "/")
	.option("--forcePathStyle", "Force path style", false);

program.parse(process.argv);

const options = program.opts();

(async () => {
	options.verbose && console.log("Verbose output enabled.");

	if (options.endpoint && !options.forcePathStyle) {
		options.forcePathStyle = true;
		options.verbose && console.log("Forcing Path Style since endpoint is specified.");
	}
	if (options.includeSitemap && !options.domain) {
		console.error("Domain is required if using sitemap. Domain is not currently set. Please set the --domain option.");
		process.exit(1);
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
	if (options.region) {
		s3ClientOptions.region = options.region;
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
		const fileName = keyParts[keyParts.length - 1];

		return {
			...object,
			"KeyParts": keyParts,
			"LevelsDeep": levelsDeep,
			"IsFolder": isFolder,
			"IsFile": isFile,
			"IsHiddenFile": fileName.startsWith("."),
			"ParentKey": parentKey,
			"FileName": fileName,
			"URL": (() => {
				if (isFolder) {
					return [options.rootPath, ...keyParts].join("/");
				} else if (options.endpoint) {
					return `${options.endpoint}/${options.bucket}/${keyParts.join("/")}`;
				} else {
					return `https://${options.forcePathStyle ? "" : `${options.bucket}.`}s3-${options.region}.amazonaws.com${options.forcePathStyle ? `/${options.bucket}` : ""}/${keyParts.join("/")}`;
				}
			})()
		};
	}).flatMap((object, _i, array) => {
		const returnArray = [object];

		for (let i = object.LevelsDeep - 1; i >= 0; i--) {
			returnArray.push(
				(() => {
					let key = object.KeyParts.slice(0, i).join("/");
					if (key.length === 0) {
						key = "/";
					}
					const keyParts = (key.split("/") ?? []).filter((part) => part.length > 0);
					const levelsDeep = keyParts.length;
					const isFolder = true;
					const isFile = !isFolder;
					const parentKey = keyParts.slice(0, -1).join("/");
					const fileName = keyParts[keyParts.length - 1] ?? "";

					return {
						"Key": key,
						"KeyParts": keyParts,
						"LevelsDeep": levelsDeep,
						"IsFolder": isFolder,
						"IsFile": isFile,
						"IsHiddenFile": fileName.startsWith("."),
						"ParentKey": parentKey,
						"FileName": fileName,
						"URL": (() => {
							return [options.rootPath, ...keyParts].join("/");
						})()
					};
				})()
			);
		}

		return returnArray;
	}).filter((object, index, array) => {
		// Filter out duplicate keys
		return array.findIndex((otherObject) => removeLeadingTrailingSlashes(otherObject.Key) === removeLeadingTrailingSlashes(object.Key)) === index;
	}).map((object, _i, array) => {
		return {
			...object,
			"Children": object.Key === "/" ? array.filter((otherObject) => otherObject.LevelsDeep === 1) : array.filter((otherObject) => removeLeadingTrailingSlashes(otherObject.ParentKey) === removeLeadingTrailingSlashes(object.Key))
		}
	});

	console.log(result);

	let sitemap: Set<string> = new Set();

	await Promise.all(result.map(async (object) => {
		if (object.IsFile) {
			return;
		}

		const file = await ejs.renderFile(path.join(__dirname, "..", "templates", "main.ejs"), {
			"title": `${options.bucket} - ${object.FileName}`,
			"items": object.Children.filter((child) => options.includeHiddenFiles || !child.IsHiddenFile).sort((a, b) => {
				if (a.IsFolder && !b.IsFolder) {
					return -1;
				} else if (!a.IsFolder && b.IsFolder) {
					return 1;
				} else {
					return a.FileName.localeCompare(b.FileName);
				}
			}),
			options,
			"functions": {
				removeLeadingTrailingSlashes
			}
		});

		const saveLocation = path.join(options.output, object.Key ?? "");
		await fs.mkdir(saveLocation, {
			"recursive": true
		});
		await fs.writeFile(path.join(saveLocation, "index.html"), file, "utf8");
		sitemap.add([options.domain, options.rootPath, object.Key].map((item) => removeLeadingTrailingSlashes(item)).filter(Boolean).join("/"));
	}));

	// Handle sitemap
	if (options.includeSitemap) {
		const parser = new XMLBuilder({
			"attributeNamePrefix": "@_",
			"ignoreAttributes": false,
			"format": true,
			"indentBy": "\t"
		});
		const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${parser.build({
			"urlset": {
				"@_xmlns": "http://www.sitemaps.org/schemas/sitemap/0.9",
				"@_xmlns:xhtml": "http://www.w3.org/1999/xhtml",
				"url": [...sitemap].sort().map((url) => ({
					"loc": url
				}))
			}
		})}`;
		await fs.writeFile(path.join(options.output, "sitemap.xml"), xml, "utf8");
	}

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

function removeLeadingTrailingSlashes(str: string | undefined) {
	if (!str) {
		return str;
	}

	while (str.startsWith('/')) {
		str = str.substring(1);
	}
	while (str.endsWith('/')) {
		str = str.substring(0, str.length - 1);
	}
	return str;
}
