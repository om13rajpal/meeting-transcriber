// Ambient type for the plain-JS button.jsx copied byte-for-byte from the
// frontend's components/ui/button.jsx. Without this, tsc infers every
// destructured prop with no default value (className) as *required*, which
// breaks on every normal <Button>. Kept loose on purpose - this project
// doesn't introduce TypeScript into the shared component source itself, see
// CLAUDE.md's "JavaScript, not TypeScript" convention.
import type { ComponentType } from 'react';

export declare const Button: ComponentType<any>;
export declare const buttonVariants: (...args: any[]) => string;
