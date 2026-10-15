import type { ImageMetadata } from 'astro'
import type { PhotoData, Photo, PolaroidVariant } from '~/types'

// Auto-import all images under the photos directory.
const photoModules = import.meta.glob<{ default: ImageMetadata }>('../assets/photos/**/*.{webp,jpg,jpeg,png}', { eager: true })

/**
 * Get a sorted list of photos by directory name.
 * @param dir - Directory name, for example '2025-06-21-cat'
 * @param alt - Image alt text
 * @param variants - Variant for each image, mapped by index
 */
function getPhotos(dir: string, alt: string, variants: PolaroidVariant[]): Photo[] {
  return Object.entries(photoModules)
    .filter(([path]) => path.includes(`/${dir}/`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, mod], index) => {
      const img = mod.default
      return {
        src: img,
        alt,
        width: img.width,
        height: img.height,
        variant: variants[index] || '4x3',
      }
    })
}

export const PhotosList: PhotoData[] = [
  // 往这里加你的相册。每个相册对应 src/assets/photos/ 下的一个文件夹，
  // 文件夹名格式：2026-01-10-classmate（年-月-日-名字）
  // 图片放进那个文件夹就会自动被收录，不用手动登记。
  //
  // {
  //   title: '植物园',
  //   icon: { type: 'emoji', value: '🌼' },
  //   description: '春天拍的。',
  //   date: '2026-03-07',
  //   travel: '',
  //   photos: getPhotos('2026-03-07-botanicalGarden', '植物园', ['3x4', '3x4']),
  // },
]
