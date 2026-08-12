import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface ImageVariants {
    display: Buffer;
    thumbnail: Buffer;
    width: number;
    height: number;
}

export interface TransformImageOptions {
    displaySize?: number;
    thumbnailSize?: number;
    maxInputBytes?: number;
    maxInputPixels?: number;
}

/**
 * Validate, EXIF-orient and transcode an uploaded image into a display and a
 * thumbnail WebP variant. Shared by entity media uploads and report screenshots
 * so the validation rules (JPEG/PNG/WebP, no animations, ≤5 MiB) stay in one place.
 */
export async function transformImageVariants(input: Buffer, opts: TransformImageOptions = {}): Promise<ImageVariants> {
    const displaySize = opts.displaySize ?? 1600;
    const thumbnailSize = opts.thumbnailSize ?? 480;
    const maxInputBytes = opts.maxInputBytes ?? 5 * 1024 * 1024;
    const maxInputPixels = opts.maxInputPixels ?? 20_000_000;

    if (input.length === 0) throw new BadRequestException('Image file is empty');
    if (input.length > maxInputBytes) throw new BadRequestException('Image exceeds the 5 MiB limit');

    try {
        const source = sharp(input, {
            failOn: 'warning',
            limitInputPixels: maxInputPixels,
            sequentialRead: true,
        });
        const metadata = await source.metadata();
        if (!metadata.format || !ALLOWED_INPUT_FORMATS.has(metadata.format)) {
            throw new BadRequestException('Only JPEG, PNG, and WebP images are accepted');
        }
        if ((metadata.pages ?? 1) > 1) throw new BadRequestException('Animated or multi-page images are not accepted');
        if (!metadata.width || !metadata.height) throw new BadRequestException('Image dimensions could not be read');

        const normalized = source.rotate();
        const displayResult = await normalized
            .clone()
            .resize({
                width: displaySize,
                height: displaySize,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .webp({ quality: 82, effort: 4 })
            .toBuffer({ resolveWithObject: true });
        const thumbnail = await normalized
            .clone()
            .resize({
                width: thumbnailSize,
                height: thumbnailSize,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .webp({ quality: 76, effort: 4 })
            .toBuffer();

        return {
            display: displayResult.data,
            thumbnail,
            width: displayResult.info.width,
            height: displayResult.info.height,
        };
    } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('The uploaded file is not a valid supported image');
    }
}