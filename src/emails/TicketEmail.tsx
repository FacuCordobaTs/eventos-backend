/** @jsxImportSource react */
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
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
}

export function TicketEmail({
  userName,
  eventName,
  receiptUrl,
  items,
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
              Abrir app
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
            {items.length > 0
              ? "Debajo tenés cada código QR con su nombre. También van incrustados en el mensaje para que los tengas sin conexión al llegar a puerta o a la barra."
              : "Abrí el enlace de la app para ver tu comprobante y los códigos cuando estén disponibles."}
          </Text>

          {items.map((item) => (
            <Section
              key={item.id}
              style={{
                marginTop: "30px",
                textAlign: "center",
                backgroundColor: "#111111",
                padding: "20px",
                borderRadius: "8px",
              }}
            >
              <Text
                style={{
                  fontSize: "18px",
                  fontWeight: "bold",
                  color: "#ffffff",
                  marginBottom: "15px",
                  marginTop: 0,
                }}
              >
                {item.name}
              </Text>
              <Img
                src={`cid:${item.id}`}
                width={200}
                height={200}
                alt={`QR ${item.name}`}
                style={{ margin: "0 auto", borderRadius: "4px" }}
              />
            </Section>
          ))}
        </Container>
      </Body>
    </Html>
  )
}
