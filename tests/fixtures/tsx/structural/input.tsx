export interface CardProps {
  title: string;
}

export function Card({ title }: CardProps) {
  const renderTitle = () => <h1>{title}</h1>;
  return <article>{renderTitle()}</article>;
}
