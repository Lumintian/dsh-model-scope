/**
 * Reversible method patches on live dsh service instances.
 *
 * dsh has no extension point for model lists, so this plugin replaces one
 * method on a service instance with a wrapper. Rules:
 *
 * - Feature-detect: if the method is missing, or the instance refuses the
 *   property, do nothing and report it. Never break startup.
 * - Patch the raw instance behind Cordis' service proxy, so every accessor
 *   (including dsh's RPC gateway, which looks methods up per call) sees it.
 * - The wrapper calls the original with the receiver it was given, so the
 *   original still sees the caller's `this.ctx`.
 * - Restoring removes the wrapper only while it is still the outermost one.
 *   If another plugin wrapped on top of it, the wrapper is switched to pass
 *   through instead, so the other plugin's wrapper keeps working.
 */

const ORIGINAL = Symbol.for('cordis.original')

export type AnyMethod = (this: unknown, ...args: unknown[]) => unknown

/** The object behind a Cordis service proxy, or the value itself. */
export function rawInstance(service: object): object {
  const original: unknown = Reflect.get(service, ORIGINAL)
  return typeof original === 'object' && original !== null ? original : service
}

export type PatchResult =
  | { ok: true; original: AnyMethod; restore: () => void }
  | { ok: false; reason: string }

/**
 * Wrap one method of a service instance.
 * @param service - the service (proxy or raw instance).
 * @param method - method name.
 * @param wrap - receives the original method, its receiver and arguments.
 */
export function patchMethod(
  service: object,
  method: string,
  wrap: (original: AnyMethod, receiver: unknown, args: unknown[]) => unknown,
): PatchResult {
  const target = rawInstance(service)
  const current: unknown = Reflect.get(target, method)
  if (typeof current !== 'function') return { ok: false, reason: `${method} is not a method` }
  const original = current as AnyMethod
  const previous = Object.getOwnPropertyDescriptor(target, method)
  let active = true
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    return active ? wrap(original, this, args) : Reflect.apply(original, this, args)
  }
  try {
    Object.defineProperty(target, method, { value: wrapper, writable: true, configurable: true, enumerable: false })
  } catch (error) {
    return { ok: false, reason: `cannot replace ${method}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (Reflect.get(target, method) !== wrapper) return { ok: false, reason: `cannot replace ${method}` }
  return {
    ok: true,
    original,
    restore: () => {
      active = false
      if (Object.getOwnPropertyDescriptor(target, method)?.value !== wrapper) return
      try {
        if (previous) Object.defineProperty(target, method, previous)
        else Reflect.deleteProperty(target, method)
      } catch {
        // The pass-through wrapper stays; behavior is already restored.
      }
    },
  }
}
