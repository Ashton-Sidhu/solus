import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Joins class names and lets a later Tailwind class win, as T3 Code's `cn`. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
