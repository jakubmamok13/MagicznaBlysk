/**
 * Moduł efektu ubocznego: instaluje polyfille od razu przy imporcie.
 *
 * Importy statyczne wykonują się w kolejności zapisu, więc zaimportowanie go
 * PRZED biblioteką gwarantuje, że polyfill zdąży zadziałać — także w workerze,
 * gdzie nie da się wywołać funkcji z wątku głównego.
 */
import { installPolyfills } from './polyfills';

installPolyfills();
