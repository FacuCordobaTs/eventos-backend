# Vinculación con Mercado Pago

El panel solicita `GET /api/mp/auth-url` con el token del staff. El backend
obtiene la productora de la sesión y genera el enlace con `MP_CLIENT_ID` y
`MP_REDIRECT_URI`; el intercambio del código utiliza esa misma configuración.
Las variables `VITE_MP_APP_ID` y `VITE_MP_REDIRECT_URI` ya no se utilizan.

Para producción en Crow, configurar en el entorno del servicio del VPS:

```dotenv
MP_CLIENT_ID=3918831191946006
MP_REDIRECT_URI=https://api.crow.ar/api/mp/callback
ADMIN_URL=https://admin.crow.ar
```

`MP_CLIENT_SECRET` debe corresponder a esa misma aplicación y permanecer solo
en el servidor. En Mercado Pago Developers, abrir esa aplicación y registrar
exactamente `https://api.crow.ar/api/mp/callback` entre sus URLs de redirección.
Este flujo aún no implementa PKCE; si la aplicación lo exige, requiere agregar
el challenge/verifier antes de poder utilizarla.

Desplegar primero el backend y reiniciar el servicio con la configuración
actualizada; luego desplegar el admin, que depende del nuevo endpoint.
Editar el `.env` local no actualiza el VPS ni la configuración de Mercado Pago.

## Diagnóstico del 8 de septiembre de 2026

Los dos archivos de logs recibidos contienen el mismo fragmento. La actividad
del cliente termina a las 12:00:56 con `/api/mp/status` y otras consultas 200.
No contienen `/api/mp/callback`; la captura muestra el rechazo dentro del
dominio de autorización de MP. No permiten conocer la causa exacta del rechazo.

En la copia local se encontró el redirect del frontend en `api.crow.ar` y el
del backend en `api.totem.uno`, además de `ADMIN_URL` en `admin.totem.uno`.
Se corrigieron ambos valores locales. La captura posterior del panel de MP
confirma que sigue registrada `https://api.totem.uno/api/mp/callback` y que
PKCE está desactivado. Debe registrarse el callback de Crow y guardar los
cambios. Falta verificar los valores efectivos del VPS.

Con el nuevo flujo, `[MP OAuth] Inicio de vinculación` permite comprobar el ID
de aplicación y redirect efectivos. Si luego no aparece el callback, revisar
la autorización en MP. Si aparece, los logs distinguen rechazo de autorización,
configuración inválida y fallo del intercambio (HTTP y código de error conocido,
sin imprimir tokens ni el cuerpo completo de la respuesta).

Las peticiones a `/.env*`, `/actuator/*`, etc. del fragmento son compatibles con
escaneos automatizados y obtuvieron 404; no explican el rechazo de OAuth.

Referencia: [OAuth de Mercado Pago](https://www.mercadopago.com.ar/developers/es/docs/security/oauth/creation).
