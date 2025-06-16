import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { arrayBuffer } from "stream/consumers";
import path from "path";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData()
  const file = formData.get("thumbnail")
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20
  if(file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail size is greater that 10MB max upload size");
  }

  const mediaType = file.type
  const imageData = await file.arrayBuffer()

  const video = getVideo(cfg.db, videoId)
  if(video?.userID != userID) {
    throw new UserForbiddenError("User cannot upload a thumbnail to this video")
  }

  const type = mediaType.split("/")
  if(type.length != 2 || type[0] != "image" ) {
    throw new UserForbiddenError("Incorrect media type")
  }
  const extension = type[1]

  const fileName = randomBytes(32).toString("base64")
  const pathToImage = path.join(cfg.assetsRoot, `${fileName}.${extension}`)
  Bun.write(pathToImage, imageData)

  const thumbnailUrl = `http://localhost:${cfg.port}/assets/${fileName}.${extension}`

  const updatedVideo = {...video, thumbnailURL: thumbnailUrl,  }
  await updateVideo(cfg.db, updatedVideo)

  return respondWithJSON(200, updatedVideo);
}
