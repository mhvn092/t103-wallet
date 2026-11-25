import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { registerDecorator, validateSync } from 'class-validator';

export function IsStringOrNumber(): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      target: target.constructor,
      propertyName: String(propertyKey),
      name: 'isStringOrNumber',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' ||
          (typeof value === 'number' && Number.isFinite(value)),
      },
    });
  };
}

export function parseValidated<T extends object>(
  dto: ClassConstructor<T>,
  input: unknown,
): { success: true; data: T } | { success: false } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { success: false };
  }
  const data = plainToInstance(dto, input);
  if (validateSync(data, { whitelist: true }).length > 0) {
    return { success: false };
  }
  return { success: true, data };
}
