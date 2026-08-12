import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join, basename, dirname, sep } from 'path';
import { LandingController } from './landing.controller';

// Resolves to the project-root public/ directory from both:
//   src/api/landing/  (dev, ts-node)  → ../../../public
//   dist/api/landing/ (prod, compiled) → ../../../public
const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');

// Same cache split Caddy used to apply before static serving moved here:
// versioned assets get a long cache, everything else (pages, SEO files)
// revalidates every time.
const LONG_LIVED_FILENAMES = new Set(['site.webmanifest', 'robots.txt', 'sitemap.xml']);

function isLongLivedAsset(filePath: string): boolean {
    if (dirname(filePath).split(sep).pop() === 'assets') return true;
    return LONG_LIVED_FILENAMES.has(basename(filePath));
}

@Module({
    imports: [
        ServeStaticModule.forRoot({
            rootPath: PUBLIC_DIR,
            serveRoot: '/',
            // Prevent static file middleware from intercepting API routes
            exclude: ['/api/*', '/health', '/webhooks/*'],
            serveStaticOptions: {
                setHeaders: (reply: any, filePath: string) => {
                    reply.header(
                        'Cache-Control',
                        isLongLivedAsset(filePath)
                            ? 'public, max-age=3600, must-revalidate'
                            : 'public, max-age=0, must-revalidate',
                    );
                },
            },
        }),
    ],
    controllers: [LandingController],
})
export class LandingModule {}
