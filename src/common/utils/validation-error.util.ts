import type { ValidationError } from '@nestjs/common';

export function flattenValidationErrors(errors: ValidationError[]): string {
  return errors
    .flatMap((err) => {
      const own = err.constraints ? Object.values(err.constraints) : [];
      const children = err.children?.length
        ? [flattenValidationErrors(err.children)]
        : [];
      return [...own, ...children];
    })
    .filter((msg) => msg.length > 0)
    .join('; ');
}
