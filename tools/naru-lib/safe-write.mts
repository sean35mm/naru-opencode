import { isAbsolute, relative, sep } from 'node:path';

export function pathContains(root: string, value: string): boolean {
    const path = relative(root, value);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

const protectedComponent = (value: string): string => value.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
export function protectedPathContains(root: string, value: string): boolean {
    const rootParts = root.replaceAll('\\', '/').split('/').filter(Boolean).map(protectedComponent);
    const valueParts = value.replaceAll('\\', '/').split('/').filter(Boolean).map(protectedComponent);
    return rootParts.length <= valueParts.length && rootParts.every((part, index) => part === valueParts[index]);
}
