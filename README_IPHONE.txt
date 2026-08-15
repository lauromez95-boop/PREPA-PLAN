PREPA FUTSAL · APP EDITABLE PARA IPHONE

1. Publica esta carpeta en una web HTTPS (GitHub Pages, Netlify, Cloudflare Pages, etc.).
2. Abre la URL desde Safari en el iPhone.
3. Safari > Compartir > Añadir a pantalla de inicio.

NOVEDADES DE ESTA VERSIÓN
- Cada entrenamiento tiene botón “Editar”.
- Se pueden cambiar fecha, tipo, objetivo, duración, intensidad, ruta y ejercicios.
- Se pueden añadir/eliminar ejercicios.
- Se puede crear un nuevo entrenamiento desde PLAN o DATOS.
- Se puede duplicar un entrenamiento en otra fecha.
- Se pueden cargar planes futuros mediante JSON o CSV.
- La propia app permite descargar una plantilla CSV para nuevos entrenamientos.
- La copia de seguridad completa incluye registros + cambios del plan.
- Se puede restaurar un día al plan original o restaurar todo el plan original.

FORMATO CSV PARA IMPORTAR NUEVOS ENTRENOS
Cada ejercicio ocupa una fila. Si varios ejercicios comparten fecha, se agrupan en el mismo entrenamiento.
Columnas:
date;phase;type;objective;duration;intensity;route;details;achilles;section;name;planned;track;suggestedLoad

track puede ser:
- strength = fuerza/carga
- reps = repeticiones/tiempo
- cardio = cardio/distancia

IMPORTANTE
Los datos se guardan localmente en el dispositivo. Exporta una copia de seguridad con frecuencia.


NOVEDADES V3
-----------
- Revisados los 82 días del 10/08/2026 al 30/10/2026 frente al Excel original.
- Nota del día visible y editable (informativa / aclaratoria / motivadora).
- Importación de entrenamientos desde Excel .xlsx/.xls/.xlsm, CSV y JSON.
- Para Excel se recomienda usar PLANTILLA_IMPORTAR_ENTRENAMIENTOS.xlsx (hojas PLAN y EJERCICIOS).
- Si una importación contiene fechas ya existentes, la app pide confirmación antes de reemplazarlas.
- El lector Excel usa SheetJS desde su CDN oficial; para la primera importación Excel abre la app con conexión a internet.
