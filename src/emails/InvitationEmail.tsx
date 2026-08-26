/** @jsxImportSource react */
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export type InvitationDrinkLine = {
  name: string
  quantity: number
}

export type InvitationEmailProps = {
  guestName: string
  eventName: string
  invitationUrl: string
  ticketTypeName: string
  /** Tragos de regalo (tarea 7.1): [{name, quantity}] de la invitación; opcional. */
  drinkLines?: InvitationDrinkLine[]
  /** Nombre del staff que armó la invitación (tarea 7.3 — "quién invitó a quién"). */
  hostedByName?: string
  /** CID opcional para el cuervo embebido. Si no se pasa, se usa el wordmark tipográfico. */
  logoCid?: string
}

const color = {
  ink: "#000000",
  paper: "#F4EFE6",
  paperMuted: "rgba(244, 239, 230, 0.55)",
  paperDim: "rgba(244, 239, 230, 0.18)",
}

const serif = `'Tiempos Headline', 'Tiempos Text', 'GT Sectra', Georgia, 'Times New Roman', serif`
const sans = `'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`

export function InvitationEmail({
  guestName,
  eventName,
  invitationUrl,
  ticketTypeName,
  drinkLines,
  hostedByName,
  logoCid,
}: InvitationEmailProps) {
  const preview = `${eventName} — tenés tu invitación.`

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: color.ink,
          color: color.paper,
          fontFamily: sans,
          margin: 0,
          padding: "48px 16px",
        }}
      >
        <Container
          style={{
            maxWidth: "560px",
            margin: "0 auto",
            border: `1px solid ${color.paperDim}`,
            padding: "56px 48px",
            backgroundColor: color.ink,
          }}
        >
          {/* Marca */}
          <Section style={{ textAlign: "center", marginBottom: "40px" }}>
            {logoCid ? (
              <Img
                src={`cid:${logoCid}`}
                width={56}
                height={56}
                alt="CROW"
                style={{ margin: "0 auto", display: "block" }}
              />
            ) : (
              <Text
                style={{
                  margin: 0,
                  fontFamily: serif,
                  fontSize: "22px",
                  fontWeight: 400,
                  letterSpacing: "0.34em",
                  textTransform: "uppercase",
                  color: color.paper,
                }}
              >
                Crow
              </Text>
            )}
          </Section>

          {/* Anfitrión — "quién invitó a quién" se ve en el mail */}
          {hostedByName ? (
            <Text
              style={{
                margin: "0 0 16px",
                fontFamily: sans,
                fontSize: "10px",
                letterSpacing: "0.3em",
                textTransform: "uppercase",
                color: color.paperMuted,
                textAlign: "center",
              }}
            >
              {hostedByName} te invita
            </Text>
          ) : null}

          {/* Título — el evento como pieza editorial */}
          <Heading
            as="h1"
            style={{
              margin: "0 0 40px",
              fontFamily: serif,
              fontSize: "32px",
              fontWeight: 400,
              lineHeight: 1.2,
              letterSpacing: "-0.01em",
              color: color.paper,
              textAlign: "center",
            }}
          >
            {eventName}
          </Heading>

          {/* Cuerpo */}
          <Text
            style={{
              margin: "0 0 16px",
              fontFamily: serif,
              fontSize: "17px",
              lineHeight: 1.6,
              color: color.paper,
            }}
          >
            {guestName},
          </Text>
          <Text
            style={{
              margin: "0 0 32px",
              fontFamily: serif,
              fontSize: "17px",
              lineHeight: 1.6,
              color: color.paper,
            }}
          >
            Tu lugar está reservado. Tocá el botón para ver tu invitación y guardar tus códigos.
          </Text>

          {/* Qué incluye la invitación */}
          <Section
            style={{
              margin: "0 0 40px",
              border: `1px solid ${color.paperDim}`,
              padding: "24px 28px",
              textAlign: "center",
            }}
          >
            <Text
              style={{
                margin: "0 0 8px",
                fontFamily: sans,
                fontSize: "10px",
                letterSpacing: "0.3em",
                textTransform: "uppercase",
                color: color.paperMuted,
              }}
            >
              Entrada
            </Text>
            <Text
              style={{
                margin: "0 0 24px",
                fontFamily: serif,
                fontSize: "20px",
                fontWeight: 400,
                color: color.paper,
              }}
            >
              {ticketTypeName}
            </Text>

            {drinkLines && drinkLines.length > 0 ? (
              <>
                <Text
                  style={{
                    margin: "0 0 8px",
                    fontFamily: sans,
                    fontSize: "10px",
                    letterSpacing: "0.3em",
                    textTransform: "uppercase",
                    color: color.paperMuted,
                  }}
                >
                  Tragos de regalo
                </Text>
                {drinkLines.map((line) => (
                  <Text
                    key={line.name}
                    style={{
                      margin: "0 0 6px",
                      fontFamily: serif,
                      fontSize: "16px",
                      color: color.paper,
                    }}
                  >
                    {line.quantity}× {line.name}
                  </Text>
                ))}
              </>
            ) : null}
          </Section>

          {/* CTA */}
          <Section style={{ margin: "0 0 56px", textAlign: "center" }}>
            <Button
              href={invitationUrl}
              style={{
                display: "inline-block",
                backgroundColor: "transparent",
                color: color.paper,
                border: `1px solid ${color.paper}`,
                padding: "14px 34px",
                fontFamily: sans,
                fontSize: "11px",
                fontWeight: 500,
                letterSpacing: "0.26em",
                textTransform: "uppercase",
                textDecoration: "none",
              }}
            >
              Ver invitación
            </Button>
          </Section>

          {/* Cierre */}
          <Hr
            style={{
              border: "none",
              borderTop: `1px solid ${color.paperDim}`,
              margin: "0 0 28px",
            }}
          />
          <Text
            style={{
              margin: 0,
              fontFamily: sans,
              fontSize: "10px",
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              color: color.paperMuted,
              textAlign: "center",
            }}
          >
            Te esperamos
          </Text>
        </Container>
      </Body>
    </Html>
  )
}
