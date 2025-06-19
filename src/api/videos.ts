import { respondWithJSON } from "./json";

import { cfg, type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";
import path from "path";

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", filePath], {
      stdout: "pipe",
      stderr: "pipe",
    })
  
  let res
  if (await proc.exited == 0) {
    res = await new Response(proc.stdout).json()
  } else {
    res = await new Response(proc.stderr).text()
    throw new Error(res)
  }

  const width = res.streams[0].width
  const height = res.streams[0].height
  const ratio = Math.floor(width/height)
  
  switch (ratio) {
    case 0:
      return "portrait"
    case 1:
      return "landscape"
    default:
      return "other"
  }
}

export async function processVideoForFastStart(inputFilePath: string) {
  const newPath = `${path.dirname(inputFilePath)}.processed.mp4`
  const proc = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", newPath])
  const code = await proc.exited
  if (code != 0) {
    throw new Error("Error processing video for fast start")
  }
  return newPath
}

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video", videoId, "by user", userID);

  const formData = await req.formData()
  const file = formData.get("video")
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  const MAX_UPLOAD_SIZE = 1 << 30
  if(file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video size is greater that 1GB max upload size");
  }

  const mediaType = file.type
  const videoData = await file.arrayBuffer()

  const video = getVideo(cfg.db, videoId)
  if(video?.userID != userID) {
    throw new UserForbiddenError("User cannot upload a video to other user")
  }

  if(mediaType != "video/mp4" ) {
    throw new UserForbiddenError("Incorrect media type")
  }

  const fileName = randomBytes(32).toString("hex")
  const filePath = path.join(cfg.assetsRoot, `${fileName}.mp4`)
  Bun.write(filePath, videoData)

  const ratio = await getVideoAspectRatio(filePath)
  const fileKey = `${ratio}/${fileName}.mp4`

  const newFilePath = await processVideoForFastStart(filePath)

  const s3file = cfg.s3Client.file(fileKey, {
  })
  await s3file.write(Bun.file(newFilePath), { type: mediaType })

  

  const updatedVideo = {...video, videoURL: `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileKey}`  }
  const actualUpdatedVideo = await updateVideo(cfg.db, updatedVideo)

  return respondWithJSON(200, actualUpdatedVideo);
}
