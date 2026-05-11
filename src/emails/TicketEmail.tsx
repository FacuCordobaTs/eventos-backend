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

export type TicketEmailItem = {
  id: string
  name: string
}

export type TicketEmailProps = {
  userName: string
  eventName: string
  receiptUrl: string
  items: TicketEmailItem[]
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

export function TicketEmail({
  userName,
  eventName,
  receiptUrl,
  items,
  logoCid,
}: TicketEmailProps) {
  const preview = `${eventName} — confirmado.`

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
          <Section style={{ textAlign: "center", marginBottom: "48px" }}>
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
            {userName},
          </Text>
          <Text
            style={{
              margin: "0 0 40px",
              fontFamily: serif,
              fontSize: "17px",
              lineHeight: 1.6,
              color: color.paper,
            }}
          >
            Tu lugar está confirmado. Los códigos viven en la app y también abajo.
          </Text>

          {/* CTA */}
          <Section style={{ margin: "0 0 56px", textAlign: "center" }}>
            <Button
              href={receiptUrl}
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
              Abrir CROW
            </Button>
          </Section>

          <Hr
            style={{
              border: "none",
              borderTop: `1px solid ${color.paperDim}`,
              margin: "0 0 48px",
            }}
          />

          {/* QRs */}
          {items.map((item, index) => (
            <Section
              key={item.id}
              style={{
                marginBottom: index === items.length - 1 ? 0 : "48px",
                textAlign: "center",
              }}
            >
              <Text
                style={{
                  margin: "0 0 10px",
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
                  fontSize: "18px",
                  fontWeight: 400,
                  color: color.paper,
                }}
              >
                {item.name}
              </Text>
              <Img
                src={`cid:${item.id}`}
                width={200}
                height={200}
                alt={`Código ${item.name}`}
                style={{ margin: "0 auto", display: "block" }}
              />
            </Section>
          ))}

          {/* Cierre */}
          <Hr
            style={{
              border: "none",
              borderTop: `1px solid ${color.paperDim}`,
              margin: "56px 0 28px",
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