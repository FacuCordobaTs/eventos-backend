/** @jsxImportSource react */
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export type TicketEmailProps = {
  userName: string
  eventName: string
  receiptUrl: string
}

export function TicketEmail({
  userName,
  eventName,
  receiptUrl,
}: TicketEmailProps) {
  const preview = `Compra confirmada: ${eventName}`
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: "#000000",
          color: "#ffffff",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
          margin: 0,
          padding: "32px 16px",
        }}
      >
        <Container
          style={{
            maxWidth: "520px",
            margin: "0 auto",
            border: "1px solid #ffffff",
            borderRadius: 0,
            padding: "32px 28px",
            backgroundColor: "#000000",
          }}
        >
          <Section
            style={{
              borderBottom: "1px solid #ffffff",
              paddingBottom: "24px",
              marginBottom: "24px",
            }}
          >
            <Text
              style={{
                margin: 0,
                fontSize: "11px",
                letterSpacing: "0.28em",
                textTransform: "uppercase",
                color: "#ffffff",
              }}
            >
              Totem
            </Text>
          </Section>
          <Heading
            as="h1"
            style={{
              margin: "0 0 16px",
              fontSize: "22px",
              fontWeight: 700,
              lineHeight: 1.35,
              color: "#ffffff",
            }}
          >
            Hola, {userName}
          </Heading>
          <Text
            style={{
              margin: "0 0 20px",
              fontSize: "16px",
              lineHeight: 1.65,
              color: "#ffffff",
            }}
          >
            Confirmamos tu compra para{" "}
            <strong style={{ color: "#ffffff" }}>{eventName}</strong>.
          </Text>
          <Section style={{ margin: "28px 0", textAlign: "center" }}>
            <Button
              href={receiptUrl}
              style={{
                display: "inline-block",
                backgroundColor: "#ffffff",
                color: "#000000",
                border: "1px solid #ffffff",
                borderRadius: 0,
                padding: "14px 28px",
                fontSize: "13px",
                fontWeight: 700,
                textDecoration: "none",
                textTransform: "uppercase",
                letterSpacing: "0.12em",
              }}
            >
              Abrir billetera
            </Button>
          </Section>
          <Text
            style={{
              margin: "24px 0 0",
              fontSize: "13px",
              lineHeight: 1.65,
              color: "#ffffff",
              borderTop: "1px solid #ffffff",
              paddingTop: "20px",
            }}
          >
            Los códigos QR para el ingreso y, si corresponde, para canjear consumos
            en barra, van adjuntos a este correo para que puedas mostrarlos sin
            conexión.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}
